import { describe, expect, it } from "vitest"

import { createGithubAuthAccess } from "../access.js"

const req = (user: unknown) => ({ req: { user } }) as never

describe("createGithubAuthAccess", () => {
  const access = createGithubAuthAccess()

  it("allows an admin everywhere", () => {
    const admin = { id: 1, role: "admin" }

    expect(access.adminOnly(req(admin))).toBe(true)
    expect(access.adminField(req(admin))).toBe(true)
    expect(access.selfOrAdmin(req(admin))).toBe(true)
  })

  it("refuses a non-admin for admin-only access", () => {
    const editor = { id: 2, role: "editor" }

    expect(access.adminOnly(req(editor))).toBe(false)
    expect(access.adminField(req(editor))).toBe(false)
  })

  it("limits a non-admin to their own document", () => {
    expect(access.selfOrAdmin(req({ id: 2, role: "editor" }))).toEqual({
      id: { equals: 2 },
    })
  })

  it("refuses an unauthenticated request", () => {
    expect(access.selfOrAdmin(req(null))).toBe(false)
  })

  it("uses a custom admin role", () => {
    const custom = createGithubAuthAccess({ adminRole: "owner" })

    expect(custom.adminOnly(req({ id: 1, role: "owner" }))).toBe(true)
    expect(custom.adminOnly(req({ id: 1, role: "admin" }))).toBe(false)
  })
})
