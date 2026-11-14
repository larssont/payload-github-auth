import path from "node:path"
import { fileURLToPath } from "node:url"
import { githubAuthPlugin } from "@larssont/payload-github-auth"
import { sqliteAdapter } from "@payloadcms/db-sqlite"
import { lexicalEditor } from "@payloadcms/richtext-lexical"
import { buildConfig } from "payload"

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const githubConfigured = Boolean(process.env.GITHUB_CLIENT_ID) && Boolean(process.env.GITHUB_CLIENT_SECRET)

const adminEmails = (process.env.ADMIN_EMAILS ?? "")
  .split(",")
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean)

export default buildConfig({
  admin: {
    user: "users",
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [
    {
      slug: "users",
      auth: {
        useAPIKey: true,
      },
      fields: [
        {
          name: "role",
          type: "select",
          defaultValue: "admin",
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
  db: sqliteAdapter({
    client: {
      url: process.env.DATABASE_URL || "file:./dev.db",
    },
  }),
  editor: lexicalEditor(),
  plugins: githubConfigured
    ? [
        githubAuthPlugin({
          clientId: process.env.GITHUB_CLIENT_ID!,
          clientSecret: process.env.GITHUB_CLIENT_SECRET!,
          access: { email: adminEmails },
          defaultRole: "admin",
          deniedRoles: ["sync"],
          allowPasswordLogin: false,
          rateLimit: false,
          serverUrl: process.env.PAYLOAD_PUBLIC_SERVER_URL || "http://localhost:3000",
        }),
      ]
    : [],
  secret: process.env.PAYLOAD_SECRET || "dev-secret",
  serverURL: process.env.PAYLOAD_PUBLIC_SERVER_URL || "http://localhost:3000",
  typescript: {
    outputFile: path.resolve(dirname, "payload-types.ts"),
  },
})
