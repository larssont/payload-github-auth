import type { Config, Field, Plugin } from "payload"

import { createAuthorizeEndpoint, createCallbackEndpoint, createCompleteEndpoint } from "./endpoints.js"
import type { GithubAuthPluginOptions } from "./options.js"
import { resolveGithubAuthConfig } from "./options.js"
import { extendGithubSession, githubJwtStrategy, revokeGithubSession } from "./strategy.js"

export type { GithubAuthAccessOptions } from "./access.js"
export { createGithubAuthAccess } from "./access.js"
export type { GithubAccessConfig, GithubAccessRule } from "./access-rules.js"
export type { GithubClient, GithubUser } from "./github-client.js"
export type { IpAddressOptions } from "./ip-address.js"
export type { GithubEmail, GithubOrg, GithubTeam } from "./oauth.js"
export type { GithubAuthPluginOptions, LoginEvent } from "./options.js"
export { parseAdminEmails } from "./options.js"
export type { RateLimitOptions } from "./rate-limit.js"

const GITHUB_LOGIN_BUTTON = "@larssont/payload-github-auth/client#GitHubLoginButton"

const hasField = (fields: Field[], name: string): boolean =>
  fields.some((field) => "name" in field && field.name === name)

/**
 * Payload does not add its email field when the local strategy is disabled.
 */
const emailField: Field = {
  name: "email",
  type: "email",
  required: true,
  unique: true,
  index: true,
  hooks: {
    beforeChange: [({ value }) => (typeof value === "string" ? value.toLowerCase().trim() : value)],
  },
}

/**
 * Payload does not add its sessions field when the local strategy is disabled.
 * The plugin adds it; there is no password column.
 */
const sessionsField: Field = {
  name: "sessions",
  type: "array",
  access: {
    read: ({ doc, req: { user } }) => user?.id === doc?.id,
    update: () => false,
  },
  admin: {
    disabled: true,
  },
  fields: [
    { name: "id", type: "text", required: true },
    { name: "createdAt", type: "date", defaultValue: () => new Date() },
    { name: "expiresAt", type: "date", required: true },
  ],
}

/**
 * GitHub admin login for Payload.
 *
 * Adds the identity fields, the GitHub authorization endpoints and the custom
 * session strategy to the configured users collection. The local email/password
 * strategy is disabled unless `allowPasswordLogin` is true.
 */
export const githubAuthPlugin =
  (options: GithubAuthPluginOptions): Plugin =>
  (incomingConfig) => {
    const config: Config = { ...incomingConfig }
    const resolved = resolveGithubAuthConfig(options, config)

    config.admin = {
      ...config.admin,
      components: {
        ...config.admin?.components,
        afterLogin: [
          ...(config.admin?.components?.afterLogin ?? []),
          {
            path: GITHUB_LOGIN_BUTTON,
            serverProps: {
              href: `/api/${resolved.usersSlug}/oauth/github`,
            },
            clientProps: {
              href: `/api/${resolved.usersSlug}/oauth/github`,
            },
          },
        ],
      },
    }

    config.collections = (config.collections ?? []).map((collection) => {
      if (collection.slug !== resolved.usersSlug) return collection

      const fields = [...collection.fields]
      if (!hasField(fields, "email")) fields.push(emailField)
      if (!hasField(fields, "sessions")) fields.push(sessionsField)
      if (!hasField(fields, "github_id")) {
        fields.push({
          name: "github_id",
          type: "text",
          unique: true,
          index: true,
          admin: {
            readOnly: true,
            position: "sidebar",
          },
          access: {
            update: () => false,
          },
        })
      }

      const endpoints = [
        ...(Array.isArray(collection.endpoints) ? collection.endpoints : []),
        createAuthorizeEndpoint(resolved),
        createCallbackEndpoint(resolved),
        createCompleteEndpoint(resolved),
      ]

      const auth = typeof collection.auth === "object" ? collection.auth : {}

      return {
        ...collection,
        auth: {
          ...auth,
          ...(resolved.allowPasswordLogin ? {} : { disableLocalStrategy: true }),
          strategies: [...(auth.strategies ?? []), githubJwtStrategy(resolved.usersSlug)],
        },
        endpoints,
        fields,
        hooks: {
          ...collection.hooks,
          afterLogout: [
            ...(collection.hooks?.afterLogout ?? []),
            (args) =>
              revokeGithubSession({
                req: args.req,
                usersSlug: resolved.usersSlug,
              }),
          ],
          afterRefresh: [
            ...(collection.hooks?.afterRefresh ?? []),
            (args) =>
              extendGithubSession({
                req: args.req,
                usersSlug: resolved.usersSlug,
              }),
          ],
        },
      }
    })

    return config
  }
