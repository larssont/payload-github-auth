import { SignJWT } from "jose"
import { JWT_AUTH_VERSION, type Payload } from "payload"
import { describe, expect, it, vi } from "vitest"

import { extendGithubSession, githubJwtStrategy, revokeGithubSession } from "../strategy.js"

const SECRET = "test-secret"
const USER_ID = "507f1f77bcf86cd799439011"

const makePayload = (user: unknown, { csrf = [] as string[], collections = undefined as unknown } = {}): Payload =>
  ({
    secret: SECRET,
    config: {
      cookiePrefix: "payload",
      auth: { jwtOrder: ["cookie"] },
      csrf,
    },
    collections,
    findByID: vi.fn().mockResolvedValue(user),
  }) as unknown as Payload

const sign = (
  claims: Record<string, unknown>,
  {
    secret = SECRET,
    expiresIn = 3600,
    alg = "HS256",
    authVersion = JWT_AUTH_VERSION,
  }: { secret?: string; expiresIn?: number; alg?: string; authVersion?: number | null } = {},
): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader(authVersion === null ? { alg } : { alg, authVersion })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(new TextEncoder().encode(secret))

const run = (
  token: string | null,
  payload: Payload,
  origin?: string,
): ReturnType<ReturnType<typeof githubJwtStrategy>["authenticate"]> => {
  const headers = new Headers()
  if (token) headers.set("cookie", `payload-token=${token}`)
  if (origin) headers.set("origin", origin)

  return githubJwtStrategy().authenticate({
    headers,
    payload,
    strategyName: "github-jwt",
  })
}

const user = (sessions: string[] = ["session-1"]) => ({
  id: USER_ID,
  email: "admin@example.com",
  sessions: sessions.map((id) => ({ id })),
})

describe("githubJwtStrategy", () => {
  it("authenticates a valid token whose session still exists", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "users",
      sid: "session-1",
    })
    const result = await run(token, makePayload(user()))

    expect(result.user?.id).toBe(USER_ID)
    expect(result.user?._sid).toBe("session-1")
    expect(result.user?._strategy).toBe("github-jwt")
    expect(result.user?.collection).toBe("users")
  })

  it("rejects a request with no token", async () => {
    const result = await run(null, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects a token signed with a different secret", async () => {
    const token = await sign({ id: USER_ID, collection: "users", sid: "session-1" }, { secret: "other-secret" })
    const result = await run(token, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects an expired token", async () => {
    const token = await sign({ id: USER_ID, collection: "users", sid: "session-1" }, { expiresIn: -60 })
    const result = await run(token, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects a token signed with another algorithm", async () => {
    const token = await sign({ id: USER_ID, collection: "users", sid: "session-1" }, { alg: "HS512" })
    const result = await run(token, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects a token without Payload's auth version", async () => {
    const token = await sign({ id: USER_ID, collection: "users", sid: "session-1" }, { authVersion: null })
    const result = await run(token, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects a token for another collection", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "members",
      sid: "session-1",
    })
    const result = await run(token, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects a token without a session id", async () => {
    const token = await sign({ id: USER_ID, collection: "users" })
    const result = await run(token, makePayload(user()))

    expect(result.user).toBeNull()
  })

  it("rejects a token whose session was revoked", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "users",
      sid: "session-1",
    })
    const result = await run(token, makePayload(user(["session-2"])))

    expect(result.user).toBeNull()
  })

  it("rejects a token whose user no longer exists", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "users",
      sid: "session-1",
    })
    const result = await run(token, makePayload(null))

    expect(result.user).toBeNull()
  })

  it("rejects a cookie from a disallowed origin", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "users",
      sid: "session-1",
    })
    const result = await run(token, makePayload(user(), { csrf: ["https://admin.example"] }), "https://evil.example")

    expect(result.user).toBeNull()
  })

  it("accepts a cookie from an allowed origin", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "users",
      sid: "session-1",
    })
    const result = await run(token, makePayload(user(), { csrf: ["https://admin.example"] }), "https://admin.example")

    expect(result.user?.id).toBe(USER_ID)
  })

  it("uses the configured collection slug", async () => {
    const token = await sign({
      id: USER_ID,
      collection: "admins",
      sid: "session-1",
    })
    const result = await githubJwtStrategy("admins").authenticate({
      headers: new Headers({ cookie: `payload-token=${token}` }),
      payload: makePayload(user()),
      strategyName: "github-jwt",
    })

    expect(result.user?.collection).toBe("admins")
  })

  it("accepts a token without a sid when sessions are disabled", async () => {
    const token = await sign({ id: USER_ID, collection: "users" })
    const payload = makePayload(user(), {
      collections: {
        users: { config: { auth: { useSessions: false } } },
      },
    })
    const result = await run(token, payload)

    expect(result.user?.id).toBe(USER_ID)
  })
})

describe("revokeGithubSession", () => {
  it("removes the current session id on logout", async () => {
    const updateOne = vi.fn().mockResolvedValue(undefined)
    const req = {
      user: {
        id: 3,
        _sid: "session-1",
        sessions: [{ id: "session-1" }, { id: "session-2" }],
      },
      payload: {
        collections: {
          users: { config: { slug: "users", auth: { tokenExpiration: 3600 } } },
        },
        db: { updateOne },
      },
    }

    await revokeGithubSession({ req } as never)

    expect(updateOne).toHaveBeenCalledWith({
      id: 3,
      collection: "users",
      data: { sessions: [{ id: "session-2" }] },
      req,
      returning: false,
    })
  })

  it("clears every session when allSessions is true", async () => {
    const updateOne = vi.fn().mockResolvedValue(undefined)
    const req = {
      searchParams: new URLSearchParams({ allSessions: "true" }),
      user: {
        id: 3,
        _sid: "session-1",
        sessions: [{ id: "session-1" }, { id: "session-2" }],
      },
      payload: {
        collections: {
          users: { config: { slug: "users", auth: { tokenExpiration: 3600 } } },
        },
        db: { updateOne },
      },
    }

    await revokeGithubSession({ req } as never)

    expect(updateOne).toHaveBeenCalledWith({
      id: 3,
      collection: "users",
      data: { sessions: [] },
      req,
      returning: false,
    })
  })

  it("clears every session when allSessions is true even without a current sid", async () => {
    const updateOne = vi.fn().mockResolvedValue(undefined)
    const req = {
      searchParams: new URLSearchParams({ allSessions: "true" }),
      user: { id: 3, sessions: [{ id: "session-1" }] },
      payload: {
        collections: {
          users: { config: { slug: "users", auth: { tokenExpiration: 3600 } } },
        },
        db: { updateOne },
      },
    }

    await revokeGithubSession({ req } as never)

    expect(updateOne).toHaveBeenCalledWith({
      id: 3,
      collection: "users",
      data: { sessions: [] },
      req,
      returning: false,
    })
  })

  it("does nothing for a request without a session id", async () => {
    const updateOne = vi.fn()
    const req = {
      user: { id: 3, sessions: [{ id: "session-1" }] },
      payload: { db: { updateOne } },
    }

    await revokeGithubSession({ req } as never)

    expect(updateOne).not.toHaveBeenCalled()
  })

  it("uses the configured collection slug", async () => {
    const updateOne = vi.fn().mockResolvedValue(undefined)
    const req = {
      user: {
        id: 3,
        _sid: "session-1",
        sessions: [{ id: "session-1" }],
      },
      payload: {
        collections: {
          admins: {
            config: { slug: "admins", auth: { tokenExpiration: 3600 } },
          },
        },
        db: { updateOne },
      },
    }

    await revokeGithubSession({ req, usersSlug: "admins" } as never)

    expect(updateOne.mock.calls[0][0].collection).toBe("admins")
  })
})

describe("extendGithubSession", () => {
  it("moves only the current session expiry forward", async () => {
    const updateOne = vi.fn().mockResolvedValue(undefined)
    const req = {
      user: {
        id: 3,
        _sid: "session-1",
        sessions: [
          { id: "session-1", expiresAt: "2020-01-01T00:00:00.000Z" },
          { id: "session-2", expiresAt: "2020-01-01T00:00:00.000Z" },
        ],
      },
      payload: {
        collections: {
          users: {
            config: { slug: "users", auth: { tokenExpiration: 3600 } },
          },
        },
        db: { updateOne },
      },
    }

    await extendGithubSession({ req } as never)

    const sessions = updateOne.mock.calls[0][0].data.sessions

    expect(new Date(sessions[0].expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(sessions[1].expiresAt).toBe("2020-01-01T00:00:00.000Z")
  })

  it("does nothing for a request without a session id", async () => {
    const updateOne = vi.fn()
    const req = {
      user: { id: 3, sessions: [{ id: "session-1" }] },
      payload: {
        collections: {
          users: {
            config: { slug: "users", auth: { tokenExpiration: 3600 } },
          },
        },
        db: { updateOne },
      },
    }

    await extendGithubSession({ req } as never)

    expect(updateOne).not.toHaveBeenCalled()
  })

  it("uses the configured collection slug", async () => {
    const updateOne = vi.fn().mockResolvedValue(undefined)
    const req = {
      user: {
        id: 3,
        _sid: "session-1",
        sessions: [{ id: "session-1", expiresAt: "2020-01-01T00:00:00.000Z" }],
      },
      payload: {
        collections: {
          admins: {
            config: { slug: "admins", auth: { tokenExpiration: 3600 } },
          },
        },
        db: { updateOne },
      },
    }

    await extendGithubSession({ req, usersSlug: "admins" } as never)

    expect(updateOne.mock.calls[0][0].collection).toBe("admins")
  })
})
