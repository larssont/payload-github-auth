import type { Config, Field } from "payload"
import { describe, expect, it } from "vitest"

import { type GithubAuthPluginOptions, parseAdminEmails, resolveGithubAuthConfig } from "../options.js"

const roleField: Field = {
  name: "role",
  type: "select",
  options: [
    { label: "Admin", value: "admin" },
    { label: "Editor", value: "editor" },
    { label: "Sync", value: "sync" },
  ],
}

const makeConfig = (overrides: Partial<Config> = {}): Config =>
  ({
    collections: [
      {
        slug: "users",
        auth: { useAPIKey: true },
        fields: [roleField],
      },
    ],
    routes: { admin: "/admin" },
    serverURL: "https://cms.example.com",
    ...overrides,
  }) as unknown as Config

const makeOptions = (overrides: Partial<GithubAuthPluginOptions> = {}): GithubAuthPluginOptions => ({
  clientId: "client",
  clientSecret: "secret",
  access: { email: ["admin@example.com"] },
  defaultRole: "admin",
  ...overrides,
})

describe("resolveGithubAuthConfig", () => {
  it("resolves the defaults from the Payload config", () => {
    const resolved = resolveGithubAuthConfig(makeOptions(), makeConfig(), "development")

    expect(resolved.usersSlug).toBe("users")
    expect(resolved.adminRoute).toBe("/admin")
    expect(resolved.serverUrl).toBe("https://cms.example.com")
    expect(resolved.defaultRole).toBe("admin")
    expect(resolved.deniedRoles).toEqual([])
    expect(resolved.appName).toBe("CMS")
    expect(resolved.allowPasswordLogin).toBe(false)
    expect(resolved.rateLimit).toEqual({})
    expect(resolved.ipAddress).toEqual({
      headers: ["x-forwarded-for"],
      trustedProxies: [],
      ipv6Subnet: 64,
    })
  })

  it("accepts custom IP address options", () => {
    const resolved = resolveGithubAuthConfig(
      makeOptions({
        ipAddress: {
          headers: ["x-real-ip"],
          trustedProxies: ["10.0.0.0/8"],
          ipv6Subnet: 56,
        },
      }),
      makeConfig(),
      "development",
    )

    expect(resolved.ipAddress.headers).toEqual(["x-real-ip"])
    expect(resolved.ipAddress.trustedProxies).toHaveLength(1)
    expect(resolved.ipAddress.ipv6Subnet).toBe(56)
  })

  it("rejects an invalid trusted proxy CIDR", () => {
    expect(() =>
      resolveGithubAuthConfig(
        makeOptions({ ipAddress: { trustedProxies: ["not-a-cidr"] } }),
        makeConfig(),
        "development",
      ),
    ).toThrow("trustedProxies")
  })

  it("rejects an invalid IPv6 subnet", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ ipAddress: { ipv6Subnet: 129 } }), makeConfig(), "development"),
    ).toThrow("ipv6Subnet")
  })

  it("rejects an empty IP header name", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ ipAddress: { headers: [""] } }), makeConfig(), "development"),
    ).toThrow("headers")
  })

  it("can enable password login", () => {
    const resolved = resolveGithubAuthConfig(makeOptions({ allowPasswordLogin: true }), makeConfig(), "development")

    expect(resolved.allowPasswordLogin).toBe(true)
  })

  it("accepts a custom app name and rate limit", () => {
    const resolved = resolveGithubAuthConfig(
      makeOptions({ appName: "Acme Admin", rateLimit: false }),
      makeConfig(),
      "development",
    )

    expect(resolved.appName).toBe("Acme Admin")
    expect(resolved.rateLimit).toBe(false)
  })

  it("uses the explicit options", () => {
    const resolved = resolveGithubAuthConfig(
      makeOptions({
        usersSlug: "admins",
        adminRoute: "/cms/",
        serverUrl: "https://admin.example.com",
        defaultRole: "editor",
        deniedRoles: ["sync"],
      }),
      makeConfig({
        collections: [
          {
            slug: "admins",
            auth: { useAPIKey: true },
            fields: [roleField],
          },
        ],
      }),
      "development",
    )

    expect(resolved.usersSlug).toBe("admins")
    expect(resolved.adminRoute).toBe("/cms")
    expect(resolved.serverUrl).toBe("https://admin.example.com")
    expect(resolved.defaultRole).toBe("editor")
    expect(resolved.deniedRoles).toEqual(["sync"])
  })

  it("accepts a nested admin route", () => {
    const resolved = resolveGithubAuthConfig(makeOptions({ adminRoute: "/cms/admin" }), makeConfig(), "development")

    expect(resolved.adminRoute).toBe("/cms/admin")
  })

  it("rejects a protocol-relative admin route", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ adminRoute: "//evil.com" }), makeConfig(), "development"),
    ).toThrow("adminRoute")
  })

  it("rejects an absolute admin route", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ adminRoute: "https://evil.com" }), makeConfig(), "development"),
    ).toThrow("adminRoute")
  })

  it("rejects a backslash admin route", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ adminRoute: "/\\evil.com" }), makeConfig(), "development"),
    ).toThrow("adminRoute")
  })

  it("rejects an admin route with a query or hash", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ adminRoute: "/admin?x=1" }), makeConfig(), "development"),
    ).toThrow("adminRoute")
    expect(() => resolveGithubAuthConfig(makeOptions({ adminRoute: "/admin#x" }), makeConfig(), "development")).toThrow(
      "adminRoute",
    )
  })

  it("normalizes a single rule", () => {
    const resolved = resolveGithubAuthConfig(makeOptions(), makeConfig(), "development")

    expect(resolved.access).toEqual({ match: "any", rules: [{ email: ["admin@example.com"] }] })
  })

  it("normalizes a shorthand list with match any", () => {
    const resolved = resolveGithubAuthConfig(
      makeOptions({
        access: [{ email: ["admin@example.com"] }, { team: "acme/engineering" }],
      }),
      makeConfig(),
      "development",
    )

    expect(resolved.access.match).toBe("any")
    expect(resolved.access.rules).toHaveLength(2)
  })

  it("keeps an explicit match", () => {
    const resolved = resolveGithubAuthConfig(
      makeOptions({
        access: {
          match: "all",
          rules: [{ email: ["admin@example.com"] }, { org: "acme" }],
        },
      }),
      makeConfig(),
      "development",
    )

    expect(resolved.access.match).toBe("all")
  })

  it("accepts a function email rule", () => {
    const resolved = resolveGithubAuthConfig(
      makeOptions({ access: { email: (email) => email.endsWith("@example.com") } }),
      makeConfig(),
      "development",
    )

    expect(typeof (resolved.access.rules[0] as { email: unknown }).email).toBe("function")
  })

  it("requires a client id and secret", () => {
    expect(() => resolveGithubAuthConfig(makeOptions({ clientId: "" }), makeConfig(), "development")).toThrow(
      "clientId",
    )

    expect(() => resolveGithubAuthConfig(makeOptions({ clientSecret: "" }), makeConfig(), "development")).toThrow(
      "clientSecret",
    )
  })

  it("requires a server URL", () => {
    expect(() => resolveGithubAuthConfig(makeOptions(), makeConfig({ serverURL: undefined }), "development")).toThrow(
      "serverUrl",
    )
  })

  it("requires defaultRole", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ defaultRole: undefined as never }), makeConfig(), "development"),
    ).toThrow("defaultRole")
  })

  it("rejects an empty access rule", () => {
    expect(() => resolveGithubAuthConfig(makeOptions({ access: { email: [] } }), makeConfig(), "development")).toThrow(
      "email",
    )
  })

  it("rejects an empty rule list", () => {
    expect(() => resolveGithubAuthConfig(makeOptions({ access: [] }), makeConfig(), "development")).toThrow(
      "at least one access rule",
    )
    expect(() => resolveGithubAuthConfig(makeOptions({ access: { rules: [] } }), makeConfig(), "development")).toThrow(
      "at least one access rule",
    )
  })

  it("rejects a rule with more than one key", () => {
    expect(() =>
      resolveGithubAuthConfig(
        makeOptions({ access: { email: ["admin@example.com"], org: "acme" } as never }),
        makeConfig(),
        "development",
      ),
    ).toThrow("exactly one")
  })

  it("rejects an invalid match", () => {
    expect(() =>
      resolveGithubAuthConfig(
        makeOptions({ access: { match: "some" as never, rules: [{ org: "acme" }] } }),
        makeConfig(),
        "development",
      ),
    ).toThrow('"any" or "all"')
  })

  it("requires HTTPS in production", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ serverUrl: "http://cms.example.com" }), makeConfig(), "production"),
    ).toThrow("HTTPS")
  })

  it("requires the users collection", () => {
    expect(() => resolveGithubAuthConfig(makeOptions({ usersSlug: "admins" }), makeConfig(), "development")).toThrow(
      '"admins"',
    )
  })

  it("requires an auth-enabled collection", () => {
    expect(() =>
      resolveGithubAuthConfig(
        makeOptions(),
        makeConfig({
          collections: [
            {
              slug: "users",
              fields: [roleField],
            },
          ],
        }),
        "development",
      ),
    ).toThrow("auth-enabled")
  })

  it("requires a role field for the default role", () => {
    expect(() =>
      resolveGithubAuthConfig(
        makeOptions(),
        makeConfig({
          collections: [
            {
              slug: "users",
              auth: { useAPIKey: true },
              fields: [],
            },
          ],
        }),
        "development",
      ),
    ).toThrow('"role"')
  })

  it("requires the default role to be a select option", () => {
    expect(() => resolveGithubAuthConfig(makeOptions({ defaultRole: "owner" }), makeConfig(), "development")).toThrow(
      '"owner"',
    )
  })

  it("rejects a denied default role", () => {
    expect(() =>
      resolveGithubAuthConfig(makeOptions({ defaultRole: "sync", deniedRoles: ["sync"] }), makeConfig(), "development"),
    ).toThrow("denied role")
  })
})

describe("parseAdminEmails", () => {
  it("splits, trims, lowercases, and drops empty entries", () => {
    expect(parseAdminEmails(" Admin@Example.com, ,ops@example.com ")).toEqual(["admin@example.com", "ops@example.com"])
  })

  it("returns an empty list for an unset value", () => {
    expect(parseAdminEmails(undefined)).toEqual([])
  })
})
