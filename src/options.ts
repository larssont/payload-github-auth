import type { CollectionSlug, Config, User } from "payload"

import { type GithubAccessConfig, normalizeAccess, type ResolvedGithubAccess } from "./access-rules.js"
import type { GithubClient } from "./github-client.js"
import { type IpAddressOptions, type ResolvedIpAddressOptions, resolveIpAddressOptions } from "./ip-address.js"
import type { RateLimitOptions } from "./rate-limit.js"

export type LoginEvent = {
  email: string
  ip: string
  userAgent?: string | null
  user: User
}

export type GithubAuthPluginOptions = {
  clientId: string
  clientSecret: string
  usersSlug?: CollectionSlug
  adminRoute?: string
  serverUrl?: string
  access: GithubAccessConfig
  defaultRole: string
  deniedRoles?: string[]
  githubClient?: GithubClient
  onLogin?: (event: LoginEvent) => Promise<void>
  ipAddress?: IpAddressOptions
  rateLimit?: RateLimitOptions
  appName?: string
  allowPasswordLogin?: boolean
}

export type ResolvedGithubAuthConfig = {
  clientId: string
  clientSecret: string
  usersSlug: CollectionSlug
  adminRoute: string
  serverUrl: string
  access: ResolvedGithubAccess
  defaultRole: string
  deniedRoles: string[]
  githubClient?: GithubClient
  onLogin?: (event: LoginEvent) => Promise<void>
  ipAddress: ResolvedIpAddressOptions
  rateLimit: RateLimitOptions
  appName: string
  allowPasswordLogin: boolean
}

export const parseAdminEmails = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)

const normalizeAdminRoute = (route: string): string => {
  const trimmed = route.trim()
  if (!trimmed) return "/admin"

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error("GitHub auth adminRoute must be a path")
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  const normalized = withLeadingSlash.replace(/\/+$/, "") || "/admin"

  if (normalized.includes("\\")) {
    throw new Error("GitHub auth adminRoute must be a path")
  }

  const url = new URL(normalized, "https://example.invalid")

  if (url.origin !== "https://example.invalid" || url.search || url.hash) {
    throw new Error("GitHub auth adminRoute must be a path")
  }

  return normalized
}

const hasRoleField = (collection: NonNullable<Config["collections"]>[number], role: string): boolean => {
  const field = collection.fields.find((entry) => "name" in entry && entry.name === "role")

  if (!field) return false
  if (field.type !== "select" || !Array.isArray(field.options)) return true

  return field.options.some((option) => (typeof option === "string" ? option === role : option.value === role))
}

/**
 * Resolve the plugin options against the incoming Payload config.
 *
 * Plugins run before Payload integrates defaults, so `config.routes` and
 * `config.serverURL` may still be unset. The resolver owns every fallback and
 * every production guard, so the rest of the plugin receives one resolved shape.
 */
export const resolveGithubAuthConfig = (
  options: GithubAuthPluginOptions,
  config: Config,
  nodeEnv = process.env.NODE_ENV,
): ResolvedGithubAuthConfig => {
  if (!options.clientId) {
    throw new Error("GitHub auth requires clientId")
  }
  if (!options.clientSecret) {
    throw new Error("GitHub auth requires clientSecret")
  }

  const usersSlug = options.usersSlug ?? "users"
  const adminRoute = normalizeAdminRoute(options.adminRoute ?? config.routes?.admin ?? "/admin")
  const serverUrl = options.serverUrl ?? config.serverURL

  if (!serverUrl) {
    throw new Error("GitHub auth requires serverUrl, or serverURL in the Payload config")
  }

  if (nodeEnv === "production" && !serverUrl.startsWith("https://")) {
    throw new Error("GitHub auth requires an HTTPS serverUrl in production")
  }

  const collection = config.collections?.find((entry) => entry.slug === usersSlug)

  if (!collection) {
    throw new Error(`GitHub auth could not find the "${usersSlug}" collection`)
  }
  if (!collection.auth) {
    throw new Error(`GitHub auth requires the "${usersSlug}" collection to be auth-enabled`)
  }

  const access = normalizeAccess(options.access)
  const defaultRole = options.defaultRole

  if (!defaultRole) {
    throw new Error("GitHub auth requires defaultRole")
  }
  if (!hasRoleField(collection, defaultRole)) {
    throw new Error(`GitHub auth requires a "role" field on "${usersSlug}" that accepts "${defaultRole}"`)
  }

  const deniedRoles = options.deniedRoles ?? []
  if (deniedRoles.includes(defaultRole)) {
    throw new Error(`GitHub auth cannot use the denied role "${defaultRole}" as defaultRole`)
  }

  const allowPasswordLogin = options.allowPasswordLogin ?? false
  const ipAddress = resolveIpAddressOptions(options.ipAddress)

  return {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    usersSlug,
    adminRoute,
    serverUrl,
    access,
    defaultRole,
    deniedRoles,
    githubClient: options.githubClient,
    onLogin: options.onLogin,
    ipAddress,
    rateLimit: options.rateLimit ?? {},
    appName: options.appName ?? "CMS",
    allowPasswordLogin,
  }
}
