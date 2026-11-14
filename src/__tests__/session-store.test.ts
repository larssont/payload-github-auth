import type { CollectionConfig, Payload } from "payload"
import { describe, expect, it, vi } from "vitest"

import { createSessionStore, type SessionUser } from "../session-store.js"

const collectionConfig = {
  slug: "users",
  auth: { tokenExpiration: 3600 },
} as unknown as CollectionConfig

const makeStore = () => {
  const updateOne = vi.fn().mockResolvedValue(undefined)
  const payload = { db: { updateOne } } as unknown as Payload

  return { store: createSessionStore({ payload }), updateOne }
}

const user = (sessions: SessionUser["sessions"] = []): SessionUser =>
  ({
    id: 3,
    email: "admin@example.com",
    sessions,
  }) as SessionUser

const future = (): string => new Date(Date.now() + 3_600_000).toISOString()

describe("createSessionStore", () => {
  it("finds a session by id", () => {
    const { store } = makeStore()
    const sessions = [{ id: "session-1", expiresAt: future() }]

    expect(store.find(user(sessions), "session-1")).toBe(true)
    expect(store.find(user(sessions), "session-2")).toBe(false)
  })

  it("revokes only the current session", async () => {
    const { store, updateOne } = makeStore()

    await store.revoke(
      user([
        { id: "session-1", expiresAt: future() },
        { id: "session-2", expiresAt: future() },
      ]),
      "session-1",
      collectionConfig,
    )

    const sessions = updateOne.mock.calls[0][0].data.sessions

    expect(sessions.map((session: { id: string }) => session.id)).toEqual(["session-2"])
  })

  it("revokes every session", async () => {
    const { store, updateOne } = makeStore()

    await store.revokeAll(
      user([
        { id: "session-1", expiresAt: future() },
        { id: "session-2", expiresAt: future() },
      ]),
      collectionConfig,
    )

    expect(updateOne.mock.calls[0][0].data.sessions).toEqual([])
  })

  it("extends only the current session", async () => {
    const { store, updateOne } = makeStore()
    const old = "2020-01-01T00:00:00.000Z"

    await store.extend(
      user([
        { id: "session-1", expiresAt: old },
        { id: "session-2", expiresAt: old },
      ]),
      "session-1",
      collectionConfig,
    )

    const sessions = updateOne.mock.calls[0][0].data.sessions

    expect(new Date(sessions[0].expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(sessions[1].expiresAt).toBe(old)
  })
})
