import { afterEach, describe, expect, it, vi } from "vitest"

import { createGithubClient } from "../github-client.js"

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })

const exchangeInput = {
  clientId: "client",
  clientSecret: "secret",
  callbackUrl: "http://localhost:3000/api/users/oauth/github/callback",
  code: "code",
  verifier: "verifier",
}

describe("createGithubClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("builds the authorize URL", () => {
    const url = new URL(
      createGithubClient().authorizeUrl({
        clientId: "client",
        callbackUrl: "http://localhost:3000/api/users/oauth/github/callback",
        state: "state",
        challenge: "challenge",
      }),
    )

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("client")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/users/oauth/github/callback")
    expect(url.searchParams.get("state")).toBe("state")
    expect(url.searchParams.get("code_challenge")).toBe("challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })

  it("exchanges the code in the request body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ access_token: "token" }))
    vi.stubGlobal("fetch", fetchMock)

    const token = await createGithubClient().exchangeCode(exchangeInput)

    expect(token).toBe("token")
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://github.com/login/oauth/access_token")
    expect(init.method).toBe("POST")

    const body = new URLSearchParams(init.body as string)
    expect(body.get("client_id")).toBe("client")
    expect(body.get("client_secret")).toBe("secret")
    expect(body.get("code")).toBe("code")
    expect(body.get("redirect_uri")).toBe(exchangeInput.callbackUrl)
    expect(body.get("code_verifier")).toBe("verifier")
  })

  it("rejects a failed token exchange", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 500)))

    await expect(createGithubClient().exchangeCode(exchangeInput)).rejects.toThrow("500")
  })

  it("rejects a token response without an access token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ error: "bad_verification_code" })))

    await expect(createGithubClient().exchangeCode(exchangeInput)).rejects.toThrow("no access token")
  })

  it("fetches the user and emails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1, login: "admin", email: "admin@example.com" }))
      .mockResolvedValueOnce(jsonResponse([{ email: "admin@example.com", primary: true, verified: true }]))
    vi.stubGlobal("fetch", fetchMock)

    const client = createGithubClient()
    const user = await client.fetchUser("token")
    const emails = await client.fetchEmails("token")

    expect(user.id).toBe(1)
    expect(emails[0].email).toBe("admin@example.com")
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token")
  })

  it("rejects a failed user request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 401)))

    await expect(createGithubClient().fetchUser("token")).rejects.toThrow("401")
  })

  it("rejects a failed emails request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)))

    await expect(createGithubClient().fetchEmails("token")).rejects.toThrow("403")
  })

  it("rejects a non-array emails response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({})))

    await expect(createGithubClient().fetchEmails("token")).rejects.toThrow("not an array")
  })

  it("fetches orgs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([{ login: "acme" }]))
    vi.stubGlobal("fetch", fetchMock)

    const orgs = await createGithubClient().fetchOrgs("token")

    expect(orgs).toEqual([{ login: "acme" }])
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.github.com/user/orgs?per_page=100&page=1")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token")
  })

  it("checks team membership", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ state: "active" }))
    vi.stubGlobal("fetch", fetchMock)

    const active = await createGithubClient().fetchTeamMembership("token", "acme", "engineering", "octocat")

    expect(active).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe("https://api.github.com/orgs/acme/teams/engineering/memberships/octocat")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token")
  })

  it("treats a pending membership as not active", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ state: "pending" })))

    await expect(createGithubClient().fetchTeamMembership("token", "acme", "engineering", "octocat")).resolves.toBe(
      false,
    )
  })

  it("treats a missing membership as not active", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 404)))

    await expect(createGithubClient().fetchTeamMembership("token", "acme", "engineering", "octocat")).resolves.toBe(
      false,
    )
  })

  it("rejects a failed team membership request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)))

    await expect(createGithubClient().fetchTeamMembership("token", "acme", "engineering", "octocat")).rejects.toThrow(
      "403",
    )
  })

  it("follows the Link header for the next page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ login: "acme" }], 200, {
          link: '<https://api.github.com/user/orgs?per_page=100&page=2>; rel="next"',
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ login: "other" }]))
    vi.stubGlobal("fetch", fetchMock)

    const orgs = await createGithubClient().fetchOrgs("token")

    expect(orgs).toEqual([{ login: "acme" }, { login: "other" }])
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/user/orgs?per_page=100&page=2")
  })

  it("rejects a failed orgs request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 403)))

    await expect(createGithubClient().fetchOrgs("token")).rejects.toThrow("403")
  })
})
