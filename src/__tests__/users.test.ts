import type { PayloadRequest } from "payload"
import { describe, expect, it, vi } from "vitest"

import { upsertUser } from "../users.js"

const USERS_SLUG = "users" as never

const makeReq = ({
  byGithub = [] as unknown[],
  byEmail = [] as unknown[],
  auth = { disableLocalStrategy: true },
} = {}) => {
  const find = vi.fn().mockResolvedValueOnce({ docs: byGithub }).mockResolvedValueOnce({ docs: byEmail })
  const update = vi.fn().mockResolvedValue({ id: 3 })
  const create = vi.fn().mockResolvedValue({ id: 4 })

  return {
    req: {
      payload: {
        find,
        update,
        create,
        collections: { users: { config: { auth } } },
      },
    } as unknown as PayloadRequest,
    find,
    update,
    create,
  }
}

const upsert = (req: PayloadRequest, overrides: Partial<Parameters<typeof upsertUser>[0]> = {}) =>
  upsertUser({
    req,
    usersSlug: USERS_SLUG,
    githubUser: { id: 123, login: "octocat" },
    email: "admin@example.com",
    defaultRole: "admin",
    deniedRoles: [],
    ...overrides,
  })

describe("upsertUser", () => {
  it("returns the user matched by GitHub id", async () => {
    const { req } = makeReq({
      byGithub: [
        {
          id: 3,
          email: "admin@example.com",
          role: "admin",
          github_id: "123",
        },
      ],
    })

    const user = await upsert(req)

    expect(user.id).toBe(3)
  })

  it("updates the email when the GitHub email changed", async () => {
    const { req, update } = makeReq({
      byGithub: [
        {
          id: 3,
          email: "old@example.com",
          role: "admin",
          github_id: "123",
        },
      ],
    })

    await upsert(req)

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        data: { email: "admin@example.com" },
      }),
    )
  })

  it("refuses a denied role", async () => {
    const { req } = makeReq({
      byGithub: [{ id: 3, role: "sync", github_id: "123" }],
    })

    await expect(upsert(req, { deniedRoles: ["sync"] })).rejects.toThrow("denied role")
  })

  it("links an existing email with no GitHub id", async () => {
    const { req, update } = makeReq({
      byEmail: [
        {
          id: 3,
          email: "admin@example.com",
          role: "admin",
          github_id: null,
        },
      ],
    })

    await upsert(req)

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 3,
        data: { github_id: "123" },
      }),
    )
  })

  it("refuses to relink a different GitHub identity", async () => {
    const { req } = makeReq({
      byEmail: [
        {
          id: 3,
          email: "admin@example.com",
          role: "admin",
          github_id: "999",
        },
      ],
    })

    await expect(upsert(req)).rejects.toThrow("different GitHub identity")
  })

  it("refuses to link a denied role", async () => {
    const { req } = makeReq({
      byEmail: [{ id: 3, role: "sync", github_id: null }],
    })

    await expect(upsert(req, { deniedRoles: ["sync"] })).rejects.toThrow("denied role")
  })

  it("creates a new user with the default role", async () => {
    const { req, create } = makeReq()

    await upsert(req)

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "admin@example.com",
          github_id: "123",
          role: "admin",
        }),
      }),
    )
  })

  it("adds a random password when the local strategy is enabled", async () => {
    const { req, create } = makeReq({ auth: { disableLocalStrategy: false } })

    await upsert(req)

    const data = create.mock.calls[0][0].data as { password?: string }

    expect(typeof data.password).toBe("string")
    expect(data.password?.length).toBeGreaterThan(20)
  })

  it("does not add a password when the local strategy is disabled", async () => {
    const { req, create } = makeReq()

    await upsert(req)

    expect(create.mock.calls[0][0].data).not.toHaveProperty("password")
  })

  it("does not request hidden fields", async () => {
    const { req, find, create } = makeReq()

    await upsert(req)

    expect(find).toHaveBeenCalledWith(expect.not.objectContaining({ showHiddenFields: true }))
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ showHiddenFields: true }))
  })

  it("refuses to create a user with a denied default role", async () => {
    const { req } = makeReq()

    await expect(upsert(req, { defaultRole: "sync", deniedRoles: ["sync"] })).rejects.toThrow("denied role")
  })
})
