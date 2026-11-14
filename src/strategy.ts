import { jwtVerify } from "jose"
import { type AuthStrategy, type CollectionSlug, JWT_AUTH_VERSION, type PayloadRequest, type User } from "payload"
import { extractJWT } from "payload/shared"

import { createSessionStore, type SessionUser } from "./session-store.js"

const ALGORITHM = "HS256"

type GithubTokenClaims = {
  id?: unknown
  collection?: unknown
  sid?: unknown
}

type AuthenticatedSessionUser = SessionUser & {
  _sid?: string
  _strategy?: string
  collection?: string
}

/**
 * Authenticates the `payload-token` that the GitHub callback mints.
 *
 * Payload's built-in JWT strategy refuses to run when the local strategy is
 * disabled, so this replaces it. It keeps Payload's own token extraction, which
 * applies the CSRF origin check, and verifies the HS256 signature with the
 * Payload secret. The session id must still be present on the user, so logout
 * revokes the token.
 */
export const githubJwtStrategy = (usersSlug: CollectionSlug = "users"): AuthStrategy => ({
  name: "github-jwt",
  authenticate: async ({ headers, payload, req, strategyName }) => {
    let token: string | null

    try {
      token = extractJWT({ headers, payload })
    } catch {
      return { user: null }
    }

    if (!token) return { user: null }

    try {
      const { payload: claims, protectedHeader } = await jwtVerify(token, new TextEncoder().encode(payload.secret), {
        algorithms: [ALGORITHM],
      })

      // Payload versions its token format in the protected header. Match its
      // built-in strategy so a token from an older or newer format is rejected.
      if ((protectedHeader as { authVersion?: unknown }).authVersion !== JWT_AUTH_VERSION) {
        return { user: null }
      }

      const { id, collection, sid } = claims as GithubTokenClaims

      if (collection !== usersSlug) return { user: null }
      if (typeof id !== "string" && typeof id !== "number") {
        return { user: null }
      }

      const collectionConfig = payload.collections?.[usersSlug]?.config
      const useSessions =
        typeof collectionConfig?.auth === "object" ? collectionConfig.auth.useSessions !== false : true
      const sessionId = typeof sid === "string" ? sid : undefined

      if (useSessions && !sessionId) return { user: null }

      const user = (await payload.findByID({
        collection: usersSlug,
        id,
        depth: 0,
        overrideAccess: true,
        req,
      })) as AuthenticatedSessionUser | null

      if (!user) return { user: null }

      if (useSessions && sessionId) {
        const store = createSessionStore({ payload, req })
        if (!store.find(user, sessionId)) {
          return { user: null }
        }
        user._sid = sessionId
      }

      user._strategy = strategyName ?? "github-jwt"
      user.collection = usersSlug

      return { user: user as unknown as User }
    } catch {
      return { user: null }
    }
  },
})

/**
 * Payload skips its own session removal on logout when the local strategy is
 * disabled. This revokes the current session, or every session when the logout
 * request asks for `allSessions=true`.
 */
export const revokeGithubSession = async ({
  req,
  usersSlug = "users",
}: {
  req: PayloadRequest
  usersSlug?: CollectionSlug
}): Promise<void> => {
  const user = req.user as AuthenticatedSessionUser | null
  if (!user) return

  const collectionConfig = req.payload.collections?.[usersSlug]?.config
  if (!collectionConfig) return

  const store = createSessionStore({ payload: req.payload, req })

  if (req.searchParams?.get("allSessions") === "true") {
    await store.revokeAll(user, collectionConfig)
    return
  }

  if (!user._sid) return

  await store.revoke(user, user._sid, collectionConfig)
}

/**
 * Payload also skips `extendSession` on refresh when the local strategy is
 * disabled. Without this hook an active session would keep its original
 * expiry and be pruned by the next login, signing the admin out.
 */
export const extendGithubSession = async ({
  req,
  usersSlug = "users",
}: {
  req: PayloadRequest
  usersSlug?: CollectionSlug
}): Promise<void> => {
  const user = req.user as AuthenticatedSessionUser | null
  if (!user?._sid) return

  const collectionConfig = req.payload.collections?.[usersSlug]?.config
  if (!collectionConfig) return

  const store = createSessionStore({ payload: req.payload, req })
  await store.extend(user, user._sid, collectionConfig)
}
