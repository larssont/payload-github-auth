import type { Endpoint } from "payload"
import { parseCookies } from "payload/shared"

import { accessNeedsOrgList, isAllowedAccess, teamRulesFor } from "./access-rules.js"
import { createGithubClient } from "./github-client.js"
import { clientIp, rateLimitKey } from "./ip-address.js"
import { sendLoginEmail } from "./notify.js"
import {
  type CookieOptions,
  callbackUrlFor,
  clearCookie,
  createPkce,
  createState,
  oauthPathFor,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  safeEqual,
  selectVerifiedEmail,
  serializeCookie,
  VERIFIER_COOKIE,
} from "./oauth.js"
import type { ResolvedGithubAuthConfig } from "./options.js"
import { createRateLimiter } from "./rate-limit.js"
import { createPayloadSession } from "./session.js"
import { upsertUser } from "./users.js"

const adminBaseFor = (adminRoute: string): string => adminRoute.replace(/\/+$/, "") || "/admin"

const callbackErrorFor = (adminRoute: string): string => `${adminBaseFor(adminRoute)}/login?error=github`

const cookieOptions = (serverUrl: string, path: string): CookieOptions => ({
  httpOnly: true,
  secure: serverUrl.startsWith("https://"),
  sameSite: "Lax",
  path,
})

const appendClearedOAuthCookies = (headers: Headers, serverUrl: string, path: string): void => {
  headers.append("Set-Cookie", clearCookie(STATE_COOKIE, cookieOptions(serverUrl, path)))
  headers.append("Set-Cookie", clearCookie(VERIFIER_COOKIE, cookieOptions(serverUrl, path)))
}

export const createAuthorizeEndpoint = (config: ResolvedGithubAuthConfig): Endpoint => {
  const client = config.githubClient ?? createGithubClient()
  const rateLimiter = createRateLimiter(config.rateLimit)
  const oauthPath = oauthPathFor(config.usersSlug)
  const callbackUrl = callbackUrlFor(config.serverUrl, config.usersSlug)
  const errorPath = callbackErrorFor(config.adminRoute)
  return {
    path: "/oauth/github",
    method: "get",
    handler: async (req) => {
      const ip = clientIp(req, config.ipAddress)
      const key = rateLimitKey(ip, config.ipAddress.ipv6Subnet)

      if (await rateLimiter(`github-auth:authorize:${key}`)) {
        const headers = new Headers({
          Location: `${errorPath}_rate`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        })
        appendClearedOAuthCookies(headers, config.serverUrl, oauthPath)
        return new Response(null, { status: 302, headers })
      }

      const state = createState()
      const { verifier, challenge } = createPkce()
      const location = client.authorizeUrl({
        clientId: config.clientId,
        callbackUrl,
        state,
        challenge,
      })

      const cookies = cookieOptions(config.serverUrl, oauthPath)
      const headers = new Headers({
        Location: location,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      headers.append(
        "Set-Cookie",
        serializeCookie(STATE_COOKIE, state, {
          ...cookies,
          maxAge: STATE_TTL_SECONDS,
        }),
      )
      headers.append(
        "Set-Cookie",
        serializeCookie(VERIFIER_COOKIE, verifier, {
          ...cookies,
          maxAge: STATE_TTL_SECONDS,
        }),
      )

      return new Response(null, { status: 302, headers })
    },
  }
}

export const createCallbackEndpoint = (config: ResolvedGithubAuthConfig): Endpoint => {
  const client = config.githubClient ?? createGithubClient()
  const rateLimiter = createRateLimiter(config.rateLimit)
  const oauthPath = oauthPathFor(config.usersSlug)
  const callbackUrl = callbackUrlFor(config.serverUrl, config.usersSlug)
  const errorPath = callbackErrorFor(config.adminRoute)
  const needsOrgList = accessNeedsOrgList(config.access)
  const teamRules = teamRulesFor(config.access)

  const fail = (reason = ""): Response => {
    const headers = new Headers({
      Location: `${errorPath}${reason}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    })
    appendClearedOAuthCookies(headers, config.serverUrl, oauthPath)
    return new Response(null, { status: 302, headers })
  }

  return {
    path: "/oauth/github/callback",
    method: "get",
    handler: async (req) => {
      const ip = clientIp(req, config.ipAddress)
      const key = rateLimitKey(ip, config.ipAddress.ipv6Subnet)

      if (await rateLimiter(`github-auth:callback:${key}`)) {
        return fail("_rate")
      }

      const code = req.searchParams.get("code")
      const state = req.searchParams.get("state")
      if (!code || !state) return fail()

      const cookies = parseCookies(req.headers)
      const cookieState = cookies.get(STATE_COOKIE)
      if (!cookieState || !safeEqual(state, cookieState)) {
        return fail("_state")
      }

      try {
        const accessToken = await client.exchangeCode({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          callbackUrl,
          code,
          verifier: cookies.get(VERIFIER_COOKIE),
        })

        const githubUser = await client.fetchUser(accessToken)
        const emails = await client.fetchEmails(accessToken)
        const email = selectVerifiedEmail(emails)

        if (!email) return fail("_email")

        const orgs = needsOrgList ? await client.fetchOrgs(accessToken) : []
        const teams = (
          await Promise.all(
            teamRules.map(async (team) => {
              const [org, slug] = team.split("/")
              const active = await client.fetchTeamMembership(accessToken, org, slug, githubUser.login)

              return active ? { slug, organization: { login: org } } : null
            }),
          )
        ).filter((team): team is { slug: string; organization: { login: string } } => team !== null)

        if (!isAllowedAccess({ access: config.access, email, orgs, teams })) {
          return fail("_not_allowed")
        }

        const user = await upsertUser({
          req,
          usersSlug: config.usersSlug,
          githubUser,
          email,
          defaultRole: config.defaultRole,
          deniedRoles: config.deniedRoles,
        })

        const collectionConfig = req.payload.collections[config.usersSlug].config
        const { token, maxAge } = await createPayloadSession({
          user,
          collectionConfig,
          req,
        })

        // The callback mints the session with Payload's createAuthToken, so
        // Payload's afterLogin hook does not run. Send the notification here
        // instead.
        const notify =
          config.onLogin ??
          ((event) =>
            sendLoginEmail({
              payload: req.payload,
              email: event.email,
              ip: event.ip,
              userAgent: event.userAgent,
              appName: config.appName,
            }))

        void notify({
          email: user.email ?? "",
          ip,
          userAgent: req.headers.get("user-agent"),
          user,
        }).catch((error: unknown) => {
          req.payload.logger.error(`github login email failed: ${(error as Error).name}`)
        })

        const cookieName = `${req.payload.config.cookiePrefix}-token`
        const headers = new Headers({
          // Payload rejects the session cookie on a cross-site navigation, and
          // the redirect from GitHub is cross-site on the first consent. Hop
          // through a same-origin page so the admin request is same-origin.
          Location: `${oauthPath}/github/complete`,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        })
        headers.append(
          "Set-Cookie",
          serializeCookie(cookieName, token, {
            httpOnly: true,
            secure: config.serverUrl.startsWith("https://"),
            sameSite: "Lax",
            path: "/",
            maxAge,
          }),
        )
        appendClearedOAuthCookies(headers, config.serverUrl, oauthPath)

        return new Response(null, { status: 302, headers })
      } catch (error) {
        req.payload.logger.error(`github auth callback failed: ${(error as Error).name}`)
        return fail()
      }
    },
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * The callback redirects here instead of straight to the admin.
 *
 * Payload's cookie extraction rejects a token when the request is a cross-site
 * navigation, and the redirect from GitHub is cross-site on the first consent
 * screen. This page is served from the app's own origin, so the navigation it
 * starts is same-origin and the admin accepts the session cookie. See
 * payloadcms/payload#16031.
 */
export const createCompleteEndpoint = (config: ResolvedGithubAuthConfig): Endpoint => {
  const href = escapeHtml(adminBaseFor(config.adminRoute))
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Signing in…</title>
</head>
<body>
<p>Signing in… <a href="${href}">Continue</a></p>
</body>
</html>
`

  return {
    path: "/oauth/github/complete",
    method: "get",
    handler: () =>
      new Response(html, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          "Referrer-Policy": "no-referrer",
        },
      }),
  }
}
