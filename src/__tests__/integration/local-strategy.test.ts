import { sqliteAdapter } from "@payloadcms/db-sqlite"
import { buildConfig, getPayload, type Payload, type PayloadRequest } from "payload"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { GithubClient } from "../../github-client.js"
import { githubAuthPlugin } from "../../index.js"

const EMAIL = "local@example.com"

const client: GithubClient = {
  authorizeUrl: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
  exchangeCode: async () => "access-token",
  fetchUser: async () => ({ id: 123, login: "octocat" }),
  fetchEmails: async () => [{ email: EMAIL, primary: true, verified: true }],
  fetchOrgs: async () => [],
  fetchTeamMembership: async () => false,
}

let payload: Payload

beforeAll(async () => {
  payload = await getPayload({
    config: buildConfig({
      admin: { user: "users" },
      collections: [
        {
          slug: "users",
          auth: { useAPIKey: true, tokenExpiration: 3600 },
          fields: [
            {
              name: "role",
              type: "select",
              options: [
                { label: "Admin", value: "admin" },
                { label: "Editor", value: "editor" },
              ],
              required: true,
            },
          ],
        },
      ],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      plugins: [
        githubAuthPlugin({
          clientId: "client",
          clientSecret: "secret",
          githubClient: client,
          access: { email: [EMAIL] },
          defaultRole: "editor",
          serverUrl: "http://localhost:3000",
          rateLimit: false,
          allowPasswordLogin: true,
          onLogin: async () => {},
        }),
      ],
      secret: "test-secret",
      serverURL: "http://localhost:3000",
    }),
  })

  vi.spyOn(payload.logger, "error").mockImplementation(() => {})
})

afterAll(async () => {
  await payload.destroy()
})

const endpoints = () => {
  const collectionEndpoints = payload.collections.users.config.endpoints

  if (!Array.isArray(collectionEndpoints)) throw new Error("missing collection endpoints")

  const authorize = collectionEndpoints.find((endpoint) => endpoint.path === "/oauth/github")
  const callback = collectionEndpoints.find((endpoint) => endpoint.path === "/oauth/github/callback")

  if (!authorize?.handler || !callback?.handler) throw new Error("missing GitHub auth endpoints")

  return { authorize, callback }
}

const makeReq = ({
  searchParams = {},
  cookie,
}: {
  searchParams?: Record<string, string>
  cookie?: string
} = {}): PayloadRequest =>
  ({
    payload,
    headers: new Headers({
      origin: "http://localhost:3000",
      "x-forwarded-for": "203.0.113.40",
      "user-agent": "vitest",
      ...(cookie ? { cookie } : {}),
    }),
    searchParams: new URLSearchParams(searchParams),
  }) as unknown as PayloadRequest

const setCookies = (response: Response): string[] =>
  (response.headers as Headers & { getSetCookie(): string[] }).getSetCookie()

const authorize = async () => {
  const { authorize: endpoint } = endpoints()
  const response = await endpoint.handler!(makeReq())
  const location = new URL(response.headers.get("Location") ?? "")
  const state = location.searchParams.get("state")

  if (!state) throw new Error("missing state")

  const cookie = setCookies(response)
    .map((entry) => entry.split(";")[0])
    .join("; ")

  return { state, cookie }
}

const callback = async ({ state, cookie }: { state: string; cookie: string }) => {
  const { callback: endpoint } = endpoints()

  return await endpoint.handler!(makeReq({ searchParams: { code: "code", state }, cookie }))
}

const tokenFrom = (response: Response): string => {
  const cookie = setCookies(response).find((entry) => entry.startsWith("payload-token="))

  if (!cookie) throw new Error("missing token cookie")

  return decodeURIComponent(cookie.split(";")[0].slice("payload-token=".length))
}

describe("GitHub App login with the local strategy enabled", () => {
  it("creates a user with a random password hash and mints a session", async () => {
    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")

    const { docs } = await payload.find({
      collection: "users",
      where: { email: { equals: EMAIL } },
      overrideAccess: true,
      showHiddenFields: true,
    })
    const user = docs[0] as { id: number | string; hash?: string; salt?: string; role?: string }

    expect(user?.role).toBe("editor")
    expect(typeof user?.hash).toBe("string")
    expect(typeof user?.salt).toBe("string")

    const token = tokenFrom(response)
    const auth = await payload.auth({
      headers: new Headers({
        cookie: `payload-token=${token}`,
        origin: "http://localhost:3000",
      }),
    })

    expect(auth.user?.id).toBe(user.id)
  })

  it("does not accept a guessed password", async () => {
    await expect(
      payload.login({
        collection: "users",
        data: { email: EMAIL, password: "not-the-random-password" },
      }),
    ).rejects.toThrow()
  })
})
