import { describe, expect, it } from "vitest"

import { isAllowedAccess, normalizeAccess } from "../access-rules.js"

describe("normalizeAccess", () => {
  it("wraps a single rule with match any", () => {
    expect(normalizeAccess({ email: ["admin@example.com"] })).toEqual({
      match: "any",
      rules: [{ email: ["admin@example.com"] }],
    })
  })

  it("wraps a shorthand list with match any", () => {
    expect(normalizeAccess([{ email: ["admin@example.com"] }, { org: "acme" }])).toEqual({
      match: "any",
      rules: [{ email: ["admin@example.com"] }, { org: "acme" }],
    })
  })

  it("keeps an explicit match", () => {
    expect(normalizeAccess({ match: "all", rules: [{ team: "acme/engineering" }] })).toEqual({
      match: "all",
      rules: [{ team: "acme/engineering" }],
    })
  })

  it("rejects an empty rule list", () => {
    expect(() => normalizeAccess([])).toThrow("at least one access rule")
    expect(() => normalizeAccess({ rules: [] })).toThrow("at least one access rule")
  })

  it("rejects a rule with no key or more than one key", () => {
    expect(() => normalizeAccess({} as never)).toThrow("exactly one")
    expect(() => normalizeAccess({ email: ["admin@example.com"], org: "acme" } as never)).toThrow("exactly one")
  })

  it("rejects a team rule without org/team-slug", () => {
    expect(() => normalizeAccess({ team: "engineering" })).toThrow("org/team-slug")
    expect(() => normalizeAccess({ team: "acme/engineering/extra" })).toThrow("org/team-slug")
  })
})

describe("isAllowedAccess", () => {
  const email = "admin@example.com"
  const orgs = [{ login: "acme" }]
  const teams = [{ slug: "engineering", organization: { login: "acme" } }]

  it("matches an email rule case-insensitively", () => {
    expect(
      isAllowedAccess({
        access: normalizeAccess({ email: ["Admin@Example.com"] }),
        email,
      }),
    ).toBe(true)
  })

  it("matches an org rule case-insensitively", () => {
    expect(isAllowedAccess({ access: normalizeAccess({ org: "ACME" }), email, orgs })).toBe(true)
    expect(isAllowedAccess({ access: normalizeAccess({ org: "other" }), email, orgs })).toBe(false)
  })

  it("matches a team rule as org/slug", () => {
    expect(isAllowedAccess({ access: normalizeAccess({ team: "ACME/Engineering" }), email, teams })).toBe(true)
    expect(isAllowedAccess({ access: normalizeAccess({ team: "acme/design" }), email, teams })).toBe(false)
  })

  it("combines rules with match any", () => {
    const access = normalizeAccess([{ email: ["other@example.com"] }, { org: "acme" }])

    expect(isAllowedAccess({ access, email, orgs })).toBe(true)
  })

  it("combines rules with match all", () => {
    const access = normalizeAccess({
      match: "all",
      rules: [{ email: ["other@example.com"] }, { org: "acme" }],
    })

    expect(isAllowedAccess({ access, email, orgs })).toBe(false)
  })
})
