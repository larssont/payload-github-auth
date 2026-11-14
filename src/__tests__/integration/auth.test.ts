import { sqliteAdapter } from "@payloadcms/db-sqlite"
import { buildConfig, getPayload, logoutOperation, type Payload, type PayloadRequest, refreshOperation } from "payload"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import type { GithubClient } from "../../github-client.js"
import { githubAuthPlugin } from "../../index.js"

const EMAIL = "admin@example.com"
const LINKED_EMAIL = "linked@example.com"
const TEAM_EMAIL = "teammate@example.com"
const DENIED_EMAIL = "denied@example.com"
const TEAM = { slug: "engineering", organization: { login: "acme" } }

const github = {
  user: { id: 123, login: "octocat" },
  emails: [{ email: EMAIL, primary: true, verified: true }],
  orgs: [] as { login: string }[],
  teams: [] as { slug: string; organization: { login: string } }[],
}

const client: GithubClient = {
  authorizeUrl: ({ state }) => `https://github.com/login/oauth/authorize?state=${state}`,
  exchangeCode: async () => "access-token",
  fetchUser: async () => github.user,
  fetchEmails: async () => github.emails,
  fetchOrgs: async () => github.orgs,
  fetchTeamMembership: async (_token, org, slug) =>
    github.teams.some((team) => team.organization.login === org && team.slug === slug),
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
                { label: "Sync", value: "sync" },
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
          access: {
            match: "any",
            rules: [{ email: [EMAIL, LINKED_EMAIL] }, { org: "acme" }, { team: "acme/engineering" }],
          },
          defaultRole: "editor",
          deniedRoles: ["sync"],
          serverUrl: "http://localhost:3000",
          rateLimit: false,
          onLogin: async () => {},
        }),
      ],
      secret: "test-secret",
      serverURL: "http://localhost:3000",
    }),
  })

  // The denied-role and relink tests intentionally make the callback log.
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
  ip = "203.0.113.10",
}: {
  searchParams?: Record<string, string>
  cookie?: string
  ip?: string
} = {}): PayloadRequest =>
  ({
    payload,
    headers: new Headers({
      origin: "http://localhost:3000",
      "x-forwarded-for": ip,
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

  return { response, state, cookie }
}

const callback = async ({ state, cookie, code = "code" }: { state: string; cookie: string; code?: string }) => {
  const { callback: endpoint } = endpoints()

  return await endpoint.handler!(makeReq({ searchParams: { code, state }, cookie }))
}

const tokenFrom = (response: Response): string => {
  const cookie = setCookies(response).find((entry) => entry.startsWith("payload-token="))

  if (!cookie) throw new Error("missing token cookie")

  return decodeURIComponent(cookie.split(";")[0].slice("payload-token=".length))
}

const findUser = async (email: string) => {
  const { docs } = await payload.find({
    collection: "users",
    where: { email: { equals: email } },
    overrideAccess: true,
  })

  return docs[0] as
    | {
        id: number | string
        email?: string
        github_id?: string | null
        role?: string
        sessions?: { id: string; expiresAt: string }[]
      }
    | undefined
}

const authenticate = async (token: string) =>
  await payload.auth({
    headers: new Headers({
      cookie: `payload-token=${token}`,
      origin: "http://localhost:3000",
    }),
  })

describe("GitHub App login", () => {
  it("creates the user, mints a session, and authenticates the token", async () => {
    github.user = { id: 123, login: "octocat" }
    github.emails = [{ email: EMAIL, primary: true, verified: true }]
    github.orgs = []
    github.teams = []

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")

    const token = tokenFrom(response)
    const user = await findUser(EMAIL)

    expect(user?.github_id).toBe("123")
    expect(user?.role).toBe("editor")
    expect(user?.sessions).toHaveLength(1)

    const auth = await authenticate(token)

    expect(auth.user?.id).toBe(user?.id)
  })

  it("links an existing user by verified email", async () => {
    const existing = await payload.create({
      collection: "users",
      data: { email: LINKED_EMAIL, role: "editor" },
      overrideAccess: true,
    })

    github.user = { id: 456, login: "octocat" }
    github.emails = [{ email: LINKED_EMAIL, primary: true, verified: true }]
    github.orgs = []
    github.teams = []

    const { state, cookie } = await authorize()
    await callback({ state, cookie })

    const linked = await payload.findByID({
      collection: "users",
      id: existing.id,
      overrideAccess: true,
    })

    expect((linked as { github_id?: string }).github_id).toBe("456")
    expect(
      await payload.count({
        collection: "users",
        where: { email: { equals: LINKED_EMAIL } },
        overrideAccess: true,
      }),
    ).toMatchObject({ totalDocs: 1 })
  })

  it("allows a team member whose email is not in an email rule", async () => {
    github.user = { id: 789, login: "octocat" }
    github.emails = [{ email: TEAM_EMAIL, primary: true, verified: true }]
    github.orgs = []
    github.teams = [TEAM]

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")
    expect(await findUser(TEAM_EMAIL)).toBeTruthy()
  })

  it("allows an org member whose email is not in an email rule", async () => {
    github.user = { id: 790, login: "octocat" }
    github.emails = [{ email: "orgmember@example.com", primary: true, verified: true }]
    github.orgs = [{ login: "acme" }]
    github.teams = []

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/api/users/oauth/github/complete")
    expect(await findUser("orgmember@example.com")).toBeTruthy()
  })

  it("rejects an unverified email", async () => {
    github.user = { id: 791, login: "octocat" }
    github.emails = [{ email: "unverified@example.com", primary: true, verified: false }]
    github.orgs = []
    github.teams = []

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_email")
    expect(await findUser("unverified@example.com")).toBeUndefined()
  })

  it("reuses the user on a second login", async () => {
    github.user = { id: 555, login: "octocat" }
    github.emails = [{ email: "reuse@example.com", primary: true, verified: true }]
    github.orgs = []
    github.teams = [TEAM]

    const first = await authorize()
    await callback({ state: first.state, cookie: first.cookie })
    const second = await authorize()
    await callback({ state: second.state, cookie: second.cookie })

    const user = await findUser("reuse@example.com")

    expect(user?.sessions).toHaveLength(2)
    expect(
      await payload.count({
        collection: "users",
        where: { email: { equals: "reuse@example.com" } },
        overrideAccess: true,
      }),
    ).toMatchObject({ totalDocs: 1 })
  })

  it("refuses to relink a user to a different GitHub identity", async () => {
    await payload.create({
      collection: "users",
      data: { email: "relink@example.com", role: "editor", github_id: "600" } as never,
      overrideAccess: true,
    })

    github.user = { id: 601, login: "octocat" }
    github.emails = [{ email: "relink@example.com", primary: true, verified: true }]
    github.orgs = []
    github.teams = [TEAM]

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/admin/login?error=github")
  })

  it("disables the local password strategy", () => {
    expect((payload.collections.users.config.auth as { disableLocalStrategy?: boolean }).disableLocalStrategy).toBe(
      true,
    )
  })

  it("fails closed when the org lookup fails", async () => {
    const original = client.fetchOrgs
    client.fetchOrgs = async () => {
      throw new Error("org lookup failed")
    }

    try {
      github.user = { id: 800, login: "octocat" }
      github.emails = [{ email: "orgfail@example.com", primary: true, verified: true }]
      github.orgs = []
      github.teams = []

      const { state, cookie } = await authorize()
      const response = await callback({ state, cookie })

      expect(response.headers.get("Location")).toBe("/admin/login?error=github")
      expect(await findUser("orgfail@example.com")).toBeUndefined()
    } finally {
      client.fetchOrgs = original
    }
  })

  it("rejects a user outside the access rules", async () => {
    github.user = { id: 999, login: "octocat" }
    github.emails = [{ email: DENIED_EMAIL, primary: true, verified: true }]
    github.orgs = []
    github.teams = []

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_not_allowed")
    expect(await findUser(DENIED_EMAIL)).toBeUndefined()
  })

  it("rejects a state mismatch before exchanging the code", async () => {
    const { cookie } = await authorize()
    const response = await callback({ state: "wrong", cookie })

    expect(response.headers.get("Location")).toBe("/admin/login?error=github_state")
  })

  it("rejects a malformed state cookie without throwing", async () => {
    const { callback: endpoint } = endpoints()
    const response = await endpoint.handler!(
      makeReq({
        searchParams: { code: "code", state: "state" },
        cookie: "payload_github_state=%E0%A4%A",
      }),
    )

    expect(response.status).toBe(302)
    expect(response.headers.get("Location")).toBe("/admin/login?error=github_state")
  })

  it("rejects a denied role after the access rules pass", async () => {
    await payload.create({
      collection: "users",
      data: { email: "sync@example.com", role: "sync", github_id: "321" } as never,
      overrideAccess: true,
    })

    github.user = { id: 321, login: "octocat" }
    github.emails = [{ email: "sync@example.com", primary: true, verified: true }]
    github.orgs = []
    github.teams = [TEAM]

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })

    expect(response.headers.get("Location")).toBe("/admin/login?error=github")
  })

  it("revokes the session on logout", async () => {
    github.user = { id: 111, login: "octocat" }
    github.emails = [{ email: "logout@example.com", primary: true, verified: true }]
    github.orgs = []
    github.teams = [TEAM]

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })
    const token = tokenFrom(response)
    const auth = await authenticate(token)

    expect(auth.user).toBeTruthy()

    await logoutOperation({
      collection: payload.collections.users,
      req: { ...makeReq(), user: auth.user, payload } as PayloadRequest,
    })

    expect((await authenticate(token)).user).toBeNull()
  })

  it("extends the session on refresh", async () => {
    github.user = { id: 222, login: "octocat" }
    github.emails = [{ email: "refresh@example.com", primary: true, verified: true }]
    github.orgs = []
    github.teams = [TEAM]

    const { state, cookie } = await authorize()
    const response = await callback({ state, cookie })
    const token = tokenFrom(response)
    const auth = await authenticate(token)
    const authUser = auth.user

    if (!authUser?._sid) throw new Error("missing authenticated session")

    const doc = (await payload.findByID({
      collection: "users",
      id: authUser.id,
      overrideAccess: true,
    })) as unknown as { sessions: { id: string; expiresAt: string }[] }
    const near = new Date(Date.now() + 1000).toISOString()
    const sessions = doc.sessions.map((session) =>
      session.id === authUser._sid ? { ...session, expiresAt: near } : session,
    )

    await payload.db.updateOne({
      id: authUser.id,
      collection: "users",
      data: { sessions },
      returning: false,
    })

    const refreshed = await refreshOperation({
      collection: payload.collections.users,
      req: {
        ...makeReq(),
        user: authUser,
        payload,
        url: "http://localhost:3000/api/users/refresh",
      } as PayloadRequest,
    })

    expect(refreshed.refreshedToken).toBeTruthy()
    expect((await authenticate(refreshed.refreshedToken)).user?.id).toBe(authUser.id)

    const after = (await payload.findByID({
      collection: "users",
      id: authUser.id,
      overrideAccess: true,
    })) as unknown as { sessions: { id: string; expiresAt: string }[] }
    const session = after.sessions.find((entry) => entry.id === authUser._sid)

    expect(new Date(session?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 30 * 60_000)
  })
})
