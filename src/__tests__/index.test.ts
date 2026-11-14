import type { Config, Field } from "payload"
import { describe, expect, it } from "vitest"

import { githubAuthPlugin } from "../index.js"

const roleField: Field = {
  name: "role",
  type: "select",
  options: [
    { label: "Admin", value: "admin" },
    { label: "Editor", value: "editor" },
  ],
}

const makeConfig = (): Config =>
  ({
    admin: { user: "users" },
    collections: [
      {
        slug: "users",
        auth: { useAPIKey: true },
        fields: [roleField],
      },
    ],
    routes: { admin: "/admin" },
    serverURL: "https://cms.example.com",
  }) as unknown as Config

const run = (overrides: Record<string, unknown> = {}): Config =>
  githubAuthPlugin({
    clientId: "client",
    clientSecret: "secret",
    access: { email: ["admin@example.com"] },
    defaultRole: "admin",
    ...overrides,
  })(makeConfig()) as Config

const usersCollection = (config: Config) => {
  const collection = config.collections?.find((entry) => entry.slug === "users")
  if (!collection) throw new Error("missing users collection")
  return collection
}

describe("githubAuthPlugin", () => {
  it("disables password login by default", () => {
    const collection = usersCollection(run())

    expect((collection.auth as { disableLocalStrategy?: boolean }).disableLocalStrategy).toBe(true)
  })

  it("keeps password login when allowPasswordLogin is true", () => {
    const collection = usersCollection(run({ allowPasswordLogin: true }))

    expect((collection.auth as { disableLocalStrategy?: boolean }).disableLocalStrategy).toBeUndefined()
  })

  it("installs the GitHub login button and the session strategy", () => {
    const config = run()
    const collection = usersCollection(config)
    const afterLogin = config.admin?.components?.afterLogin ?? []

    expect(afterLogin).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "@larssont/payload-github-auth/client#GitHubLoginButton",
        }),
      ]),
    )
    expect(
      (collection.auth as { strategies: { name: string }[] }).strategies.map((strategy) => strategy.name),
    ).toContain("github-jwt")
  })

  it("normalizes the email field", () => {
    const collection = usersCollection(run())
    const email = collection.fields.find((field) => "name" in field && field.name === "email") as Field & {
      hooks?: { beforeChange?: ((args: { value?: unknown }) => unknown)[] }
    }
    const normalize = email.hooks?.beforeChange?.[0]

    expect(normalize?.({ value: " Admin@Example.com " })).toBe("admin@example.com")
    expect(normalize?.({ value: 42 })).toBe(42)
  })

  it("protects the sessions and github_id fields", () => {
    const collection = usersCollection(run())
    const sessions = collection.fields.find((field) => "name" in field && field.name === "sessions") as Field & {
      access?: {
        read?: (args: { doc?: { id?: unknown }; req: { user?: { id?: unknown } | null } }) => boolean
        update?: () => boolean
      }
    }
    const githubId = collection.fields.find((field) => "name" in field && field.name === "github_id") as Field & {
      access?: { update?: () => boolean }
    }

    expect(sessions.access?.read?.({ doc: { id: 1 }, req: { user: { id: 1 } } })).toBe(true)
    expect(sessions.access?.read?.({ doc: { id: 1 }, req: { user: { id: 2 } } })).toBe(false)
    expect(sessions.access?.read?.({ doc: { id: 1 }, req: { user: null } })).toBe(false)
    expect(sessions.access?.update?.()).toBe(false)
    expect(githubId.access?.update?.()).toBe(false)
  })

  it("runs the logout and refresh hooks without a session", async () => {
    const collection = usersCollection(run())
    const hooks = collection.hooks as {
      afterLogout?: ((args: { req: unknown }) => Promise<void>)[]
      afterRefresh?: ((args: { req: unknown }) => Promise<void>)[]
    }

    await expect(hooks.afterLogout?.[0]?.({ req: { user: null } })).resolves.toBeUndefined()
    await expect(hooks.afterRefresh?.[0]?.({ req: { user: null } })).resolves.toBeUndefined()
  })

  it("leaves other collections untouched", () => {
    const base = makeConfig()
    const config = githubAuthPlugin({
      clientId: "client",
      clientSecret: "secret",
      access: { email: ["admin@example.com"] },
      defaultRole: "admin",
    })({
      ...base,
      collections: [...(base.collections ?? []), { slug: "posts", fields: [] }],
    } as Config) as Config
    const posts = config.collections?.find((entry) => entry.slug === "posts")

    expect(posts).toEqual({ slug: "posts", fields: [] })
  })
})
