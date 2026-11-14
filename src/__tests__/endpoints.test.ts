import type { Payload, PayloadRequest } from "payload"
import { describe, expect, it, vi } from "vitest"

import { createCallbackEndpoint, createCompleteEndpoint } from "../endpoints.js"
import type { GithubClient, GithubUser } from "../github-client.js"
import { resolveIpAddressOptions } from "../ip-address.js"
import type { GithubEmail } from "../oauth.js"
import type { ResolvedGithubAuthConfig } from "../options.js"

const baseConfig = (overrides: Partial<ResolvedGithubAuthConfig> = {}): ResolvedGithubAuthConfig => ({
  clientId: "client",
  clientSecret: "secret",
  usersSlug: "users" as never,
  adminRoute: "/admin",
  serverUrl: "http://localhost:3000",
  access: { match: "any", rules: [{ email: ["admin@example.com"] }] },
  defaultRole: "admin",
  deniedRoles: ["sync"],
  ipAddress: resolveIpAddressOptions(),
  rateLimit: false,
  appName: "CMS",
  allowPasswordLogin: false,
  ...overrides,
})

const makeClient = ({
  user = { id: 123, login: "admin" } as GithubUser,
  emails = [{ email: "admin@example.com", primary: true, verified: true }] as GithubEmail[],
  orgs = [] as { login: string }[],
  teamMemberships = {} as Record<string, boolean>,
} = {}): GithubClient => ({
  authorizeUrl: vi.fn().mockReturnValue("https://github.com/login/oauth/authorize"),
  exchangeCode: vi.fn().mockResolvedValue("access-token"),
  fetchUser: vi.fn().mockResolvedValue(user),
  fetchEmails: vi.fn().mockResolvedValue(emails),
  fetchOrgs: vi.fn().mockResolvedValue(orgs),
  fetchTeamMembership: vi.fn((_token: string, org: string, slug: string) =>
    Promise.resolve(teamMemberships[`${org}/${slug}`] ?? false),
  ),
})

const makePayload = ({ usersSlug = "users", byGithub = [] as unknown[], byEmail = [] as unknown[] } = {}) => {
  const find = vi.fn().mockResolvedValueOnce({ docs: byGithub }).mockResolvedValueOnce({ docs: byEmail })
  const update = vi.fn().mockResolvedValue({
    id: 3,
    email: "admin@example.com",
    role: "admin",
    sessions: [],
  })
  const create = vi.fn().mockResolvedValue({
    id: 4,
    email: "admin@example.com",
    role: "admin",
    sessions: [],
  })
  const updateOne = vi.fn().mockResolvedValue(undefined)
  const sendEmail = vi.fn().mockResolvedValue(undefined)
  const logger = { error: vi.fn() }
  const collectionConfig = {
    slug: usersSlug,
    fields: [],
    auth: { tokenExpiration: 3600, useSessions: true },
  }

  const payload = {
    secret: "test-secret",
    config: { cookiePrefix: "payload" },
    collections: { [usersSlug]: { config: collectionConfig } },
    find,
    update,
    create,
    db: { updateOne },
    sendEmail,
    logger,
  } as unknown as Payload

  return { payload, find, update, create, updateOne, sendEmail, logger }
}

const makeReq = ({
  payload,
  state = "state",
  code = "code",
  cookieState = state,
  verifier = "verifier",
  ip = "203.0.113.10",
}: {
  payload: Payload
  state?: string
  code?: string
  cookieState?: string
  verifier?: string
  ip?: string
}): PayloadRequest =>
  ({
    searchParams: new URLSearchParams({ code, state }),
    headers: new Headers({
      cookie: `payload_github_state=${cookieState}; payload_github_verifier=${verifier}`,
      "x-forwarded-for": ip,
      "user-agent": "vitest",
    }),
    payload,
  }) as unknown as PayloadRequest

const run = async (config: ResolvedGithubAuthConfig, req: PayloadRequest): Promise<Response> => {
  const endpoint = createCallbackEndpoint(config)
  return await endpoint.handler!(req)
}

const setCookies = (response: Response): string[] =>
  (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()

describe("createCallbackEndpoint", () => {
  it("mints a session and redirects to the admin", async () => {
    const { payload, updateOne, sendEmail } = makePayload()
    const response = await run(baseConfig({ githubClient: makeClient() }), makeReq({ payload }))

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")

    const cookies = setCookies(response)
    const tokenCookie = cookies.find((cookie) => cookie.startsWith("payload-token="))

    expect(tokenCookie).toContain("HttpOnly")
    expect(tokenCookie).toContain("SameSite=Lax")
    expect(tokenCookie).toContain("Path=/")
    expect(updateOne).toHaveBeenCalled()
    expect(sendEmail).toHaveBeenCalled()
  })

  it("rejects a state mismatch before the token exchange", async () => {
    const { payload } = makePayload()
    const client = makeClient()
    const response = await run(
      baseConfig({ githubClient: client }),
      makeReq({ payload, cookieState: "other", ip: "203.0.113.11" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_state")
    expect(client.exchangeCode).not.toHaveBeenCalled()
  })

  it("rejects an account without a verified email", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        githubClient: makeClient({
          emails: [
            {
              email: "admin@example.com",
              primary: true,
              verified: false,
            },
          ],
        }),
      }),
      makeReq({ payload, ip: "203.0.113.12" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_email")
  })

  it("rejects an account with no verified email", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({ githubClient: makeClient({ emails: [] }) }),
      makeReq({ payload, ip: "203.0.113.27" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_email")
  })

  it("rejects a callback without a code or state", async () => {
    const { payload } = makePayload()
    const endpoint = createCallbackEndpoint(baseConfig({ githubClient: makeClient() }))
    const response = await endpoint.handler!({
      searchParams: new URLSearchParams(),
      headers: new Headers({ "x-forwarded-for": "203.0.113.28" }),
      payload,
    } as unknown as PayloadRequest)

    expect(response.headers.get("Location")).toBe("/admin/login?error=github")
  })

  it("returns the generic error when the token exchange fails", async () => {
    const { payload, logger } = makePayload()
    const client = makeClient()
    client.exchangeCode = vi.fn().mockRejectedValue(new Error("boom"))

    const response = await run(baseConfig({ githubClient: client }), makeReq({ payload, ip: "203.0.113.29" }))

    expect(response.headers.get("Location")).toBe("/admin/login?error=github")
    expect(logger.error).toHaveBeenCalled()
  })

  it("rate limits the callback", async () => {
    const { payload } = makePayload()
    const endpoint = createCallbackEndpoint(
      baseConfig({ rateLimit: { max: 1, windowMs: 60_000 }, githubClient: makeClient() }),
    )
    const req = makeReq({ payload, ip: "203.0.113.30" })

    const first = await endpoint.handler!(req)
    const second = await endpoint.handler!(req)

    expect(first.headers.get("Location")).toBe("/api/users/oauth/github/complete")
    expect(second.headers.get("Location")).toBe("/admin/login?error=github_rate")
  })

  it("rejects an email outside the access rules", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        githubClient: makeClient({
          emails: [
            {
              email: "other@example.com",
              primary: true,
              verified: true,
            },
          ],
        }),
      }),
      makeReq({ payload, ip: "203.0.113.13" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_not_allowed")
  })

  it("allows an org member", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        access: { match: "any", rules: [{ org: "acme" }] },
        githubClient: makeClient({ orgs: [{ login: "acme" }] }),
      }),
      makeReq({ payload, ip: "203.0.113.19" }),
    )

    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")
  })

  it("rejects a non-member of the org", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        access: { match: "any", rules: [{ org: "acme" }] },
        githubClient: makeClient({ orgs: [{ login: "other" }] }),
      }),
      makeReq({ payload, ip: "203.0.113.20" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_not_allowed")
  })

  it("allows a team member", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        access: { match: "any", rules: [{ team: "acme/engineering" }] },
        githubClient: makeClient({
          teamMemberships: { "acme/engineering": true },
        }),
      }),
      makeReq({ payload, ip: "203.0.113.21" }),
    )

    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")
  })

  it("rejects a non-member of the team", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        access: { match: "any", rules: [{ team: "acme/engineering" }] },
        githubClient: makeClient({ teamMemberships: { "acme/engineering": false } }),
      }),
      makeReq({ payload, ip: "203.0.113.31" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_not_allowed")
  })

  it("requires every rule when match is all", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        access: {
          match: "all",
          rules: [{ email: ["admin@example.com"] }, { org: "acme" }],
        },
        githubClient: makeClient({ orgs: [{ login: "other" }] }),
      }),
      makeReq({ payload, ip: "203.0.113.22" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_not_allowed")
  })

  it("does not fetch orgs or team memberships for email-only access", async () => {
    const { payload } = makePayload()
    const client = makeClient()

    await run(baseConfig({ githubClient: client }), makeReq({ payload, ip: "203.0.113.23" }))

    expect(client.fetchOrgs).not.toHaveBeenCalled()
    expect(client.fetchTeamMembership).not.toHaveBeenCalled()
  })

  it("clears the OAuth cookies on an error path", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({ githubClient: makeClient() }),
      makeReq({ payload, cookieState: "other", ip: "203.0.113.24" }),
    )

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_state")
    expect(setCookies(response).some((cookie) => cookie.startsWith("payload_github_state=;"))).toBe(true)
    expect(setCookies(response).some((cookie) => cookie.startsWith("payload_github_verifier=;"))).toBe(true)
  })

  it("handles a malformed state cookie without throwing", async () => {
    const { payload } = makePayload()
    const req = makeReq({ payload, ip: "203.0.113.25" })
    ;(req.headers as Headers).set("cookie", "payload_github_state=%E0%A4%A")

    const response = await run(baseConfig({ githubClient: makeClient() }), req)

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/admin/login?error=github_state")
  })

  it("rejects a denied role", async () => {
    const { payload, logger } = makePayload({
      byGithub: [{ id: 3, role: "sync", github_id: "123" }],
    })
    const response = await run(baseConfig({ githubClient: makeClient() }), makeReq({ payload, ip: "203.0.113.14" }))

    expect(response.headers.get("Location")).toBe("/admin/login?error=github")
    expect(logger.error).toHaveBeenCalled()
  })

  it("rejects a relink to a different GitHub identity", async () => {
    const { payload } = makePayload({
      byEmail: [
        {
          id: 3,
          email: "admin@example.com",
          role: "admin",
          github_id: "999",
        },
      ],
    })
    const response = await run(baseConfig({ githubClient: makeClient() }), makeReq({ payload, ip: "203.0.113.15" }))

    expect(response.headers.get("Location")).toBe("/admin/login?error=github")
  })

  it("uses the configured admin route and users slug", async () => {
    const { payload } = makePayload({ usersSlug: "admins" })
    const response = await run(
      baseConfig({
        usersSlug: "admins" as never,
        adminRoute: "/cms",
        githubClient: makeClient(),
      }),
      makeReq({ payload, ip: "203.0.113.16" }),
    )

    expect(response.headers.get("Location")).toBe("/api/admins/oauth/github/complete")
  })

  it("sets a secure cookie on an HTTPS server URL", async () => {
    const { payload } = makePayload()
    const response = await run(
      baseConfig({
        serverUrl: "https://cms.example.com",
        githubClient: makeClient(),
      }),
      makeReq({ payload, ip: "203.0.113.17" }),
    )

    const tokenCookie = setCookies(response).find((cookie) => cookie.startsWith("payload-token="))

    expect(tokenCookie).toContain("Secure")
  })

  it("clears the state and verifier cookies", async () => {
    const { payload } = makePayload()
    const response = await run(baseConfig({ githubClient: makeClient() }), makeReq({ payload, ip: "203.0.113.18" }))

    const cookies = setCookies(response)

    expect(cookies.some((cookie) => cookie.startsWith("payload_github_state=;"))).toBe(true)
    expect(cookies.some((cookie) => cookie.startsWith("payload_github_verifier=;"))).toBe(true)
  })
})

describe("createCompleteEndpoint", () => {
  it("renders a same-origin page that continues to the admin", async () => {
    const endpoint = createCompleteEndpoint(baseConfig())
    const response = await endpoint.handler!(makeReq({ payload: makePayload().payload }))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("Content-Type")).toContain("text/html")
    expect(response.headers.get("Cache-Control")).toBe("no-store")
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer")
    expect(body).toContain('http-equiv="refresh"')
    expect(body).toContain("url=/admin")
    expect(body).toContain('href="/admin"')
  })

  it("uses the configured admin route", async () => {
    const endpoint = createCompleteEndpoint(baseConfig({ adminRoute: "/cms" }))
    const body = await (await endpoint.handler!(makeReq({ payload: makePayload().payload }))).text()

    expect(body).toContain("url=/cms")
    expect(body).toContain('href="/cms"')
  })
})
