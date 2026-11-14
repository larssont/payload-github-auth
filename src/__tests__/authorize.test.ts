import type { PayloadRequest } from "payload"
import { describe, expect, it, vi } from "vitest"

import { createAuthorizeEndpoint } from "../endpoints.js"
import type { GithubClient } from "../github-client.js"
import { resolveIpAddressOptions } from "../ip-address.js"
import type { ResolvedGithubAuthConfig } from "../options.js"

const baseConfig = (overrides: Partial<ResolvedGithubAuthConfig> = {}): ResolvedGithubAuthConfig => ({
  clientId: "client",
  clientSecret: "secret",
  usersSlug: "users" as never,
  adminRoute: "/admin",
  serverUrl: "http://localhost:3000",
  access: { match: "any", rules: [{ email: ["admin@example.com"] }] },
  defaultRole: "admin",
  deniedRoles: [],
  ipAddress: resolveIpAddressOptions(),
  rateLimit: false,
  appName: "CMS",
  allowPasswordLogin: false,
  ...overrides,
})

const makeReq = (ip = "203.0.113.10"): PayloadRequest =>
  ({
    headers: new Headers({ "x-forwarded-for": ip }),
  }) as unknown as PayloadRequest

const makeReqWithHeaders = (headers: Record<string, string>): PayloadRequest =>
  ({ headers: new Headers(headers) }) as unknown as PayloadRequest

const run = async (config: ResolvedGithubAuthConfig, req = makeReq()): Promise<Response> => {
  const endpoint = createAuthorizeEndpoint(config)
  return await endpoint.handler!(req)
}

const setCookies = (response: Response): string[] =>
  (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()

describe("createAuthorizeEndpoint", () => {
  it("redirects to GitHub with a state and PKCE cookie", async () => {
    const response = await run(baseConfig())

    expect(response.status).toBe(302)

    const location = new URL(response.headers.get("Location") ?? "")
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(location.searchParams.get("client_id")).toBe("client")
    expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/users/oauth/github/callback")
    expect(location.searchParams.get("scope")).toBe("offline_access")
    expect(location.searchParams.get("code_challenge_method")).toBe("S256")
    expect(location.searchParams.get("state")).toBeTruthy()
    expect(location.searchParams.get("code_challenge")).toBeTruthy()

    const cookies = setCookies(response)
    const stateCookie = cookies.find((cookie) => cookie.startsWith("payload_github_state="))
    const verifierCookie = cookies.find((cookie) => cookie.startsWith("payload_github_verifier="))

    expect(stateCookie).toContain(`payload_github_state=${location.searchParams.get("state")}`)
    expect(stateCookie).toContain("Max-Age=600")
    expect(stateCookie).toContain("Path=/api/users/oauth")
    expect(stateCookie).toContain("HttpOnly")
    expect(stateCookie).toContain("SameSite=Lax")
    expect(stateCookie).not.toContain("Secure")
    expect(verifierCookie).toBeTruthy()
  })

  it("requests offline_access even with org rules", async () => {
    const response = await run(baseConfig({ access: { match: "any", rules: [{ team: "acme/engineering" }] } }))

    const location = new URL(response.headers.get("Location") ?? "")

    expect(location.searchParams.get("scope")).toBe("offline_access")
  })

  it("marks the cookies secure on an HTTPS server", async () => {
    const response = await run(baseConfig({ serverUrl: "https://cms.example.com" }))

    expect(setCookies(response).every((cookie) => cookie.includes("Secure"))).toBe(true)
  })

  it("redirects to the login page when the rate limit is hit", async () => {
    const endpoint = createAuthorizeEndpoint(baseConfig({ rateLimit: { max: 1, windowMs: 60_000 } }))
    const req = makeReq()

    const first = await endpoint.handler!(req)
    const second = await endpoint.handler!(req)

    expect(first.headers.get("Location")).toContain("github.com/login/oauth/authorize")
    expect(second.status).toBe(302)
    expect(second.headers.get("Location")).toBe("/admin/login?error=github_rate")
    expect(setCookies(second).some((cookie) => cookie.startsWith("payload_github_state=;"))).toBe(true)
    expect(setCookies(second).some((cookie) => cookie.startsWith("payload_github_verifier=;"))).toBe(true)
  })

  it("uses the configured IP header for the rate limit", async () => {
    const endpoint = createAuthorizeEndpoint(
      baseConfig({
        ipAddress: resolveIpAddressOptions({ headers: ["x-real-ip"] }),
        rateLimit: { max: 1, windowMs: 60_000 },
      }),
    )

    const first = await endpoint.handler!(
      makeReqWithHeaders({ "x-real-ip": "203.0.113.50", "x-forwarded-for": "1.1.1.1" }),
    )
    const second = await endpoint.handler!(
      makeReqWithHeaders({ "x-real-ip": "203.0.113.50", "x-forwarded-for": "2.2.2.2" }),
    )

    expect(first.headers.get("Location")).toContain("github.com/login/oauth/authorize")
    expect(second.headers.get("Location")).toBe("/admin/login?error=github_rate")
  })

  it("uses a custom oauth client", async () => {
    const authorizeUrl = vi.fn().mockReturnValue("https://github.com/login/oauth/authorize?client_id=client")
    const client = {
      authorizeUrl,
      exchangeCode: vi.fn(),
      fetchUser: vi.fn(),
      fetchEmails: vi.fn(),
      fetchOrgs: vi.fn(),
      fetchTeamMembership: vi.fn(),
    } as unknown as GithubClient

    const response = await run(baseConfig({ githubClient: client }))

    expect(response.headers.get("Location")).toBe("https://github.com/login/oauth/authorize?client_id=client")
    expect(authorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "client",
        callbackUrl: "http://localhost:3000/api/users/oauth/github/callback",
      }),
    )
  })
})
