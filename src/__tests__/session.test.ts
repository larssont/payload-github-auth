import { decodeJwt } from "jose"
import type { Payload, PayloadRequest, SanitizedCollectionConfig, User } from "payload"
import { describe, expect, it, vi } from "vitest"

import { createPayloadSession } from "../session.js"

const collectionConfig = {
  slug: "users",
  fields: [],
  auth: { tokenExpiration: 3600, useSessions: true },
} as unknown as SanitizedCollectionConfig

const makePayload = () => {
  const updateOne = vi.fn().mockResolvedValue(undefined)
  const payload = {
    secret: "test-secret",
    db: { updateOne },
  } as unknown as Payload

  return { payload, updateOne }
}

const user = (sessions: User["sessions"] = []) =>
  ({
    id: 3,
    email: "admin@example.com",
    sessions,
  }) as User

describe("createPayloadSession", () => {
  it("mints a token with the session id", async () => {
    const { payload, updateOne } = makePayload()

    const { token, maxAge } = await createPayloadSession({
      user: user(),
      collectionConfig,
      req: { payload } as PayloadRequest,
    })

    const claims = decodeJwt(token)

    expect(maxAge).toBe(3600)
    expect(updateOne).toHaveBeenCalled()
    expect(claims.id).toBe(3)
    expect(claims.collection).toBe("users")
    expect(claims.email).toBe("admin@example.com")
    expect(typeof claims.sid).toBe("string")
  })

  it("skips the session when useSessions is false", async () => {
    const { payload, updateOne } = makePayload()
    const config = {
      ...collectionConfig,
      auth: { tokenExpiration: 3600, useSessions: false },
    } as unknown as SanitizedCollectionConfig

    const { token } = await createPayloadSession({
      user: user(),
      collectionConfig: config,
      req: { payload } as PayloadRequest,
    })

    expect(updateOne).not.toHaveBeenCalled()
    expect(decodeJwt(token).sid).toBeUndefined()
  })
})
