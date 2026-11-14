import crypto from "node:crypto"

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"

export const STATE_COOKIE = "payload_github_state"
export const VERIFIER_COOKIE = "payload_github_verifier"
export const STATE_TTL_SECONDS = 600

export const oauthPathFor = (usersSlug: string): string => `/api/${usersSlug}/oauth`

export type GithubEmail = {
  email: string
  primary: boolean
  verified: boolean
}

export type GithubOrg = {
  login: string
}

export type GithubTeam = {
  slug: string
  organization: {
    login: string
  }
}

export type PkceCodes = {
  verifier: string
  challenge: string
}

export type CookieOptions = {
  httpOnly?: boolean
  secure?: boolean
  sameSite?: "Lax" | "Strict" | "None"
  path?: string
  maxAge?: number
}

export const createState = (): string => crypto.randomBytes(32).toString("base64url")

export const createPkce = (): PkceCodes => {
  const verifier = crypto.randomBytes(32).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")

  return { verifier, challenge }
}

export const callbackUrlFor = (serverUrl: string, usersSlug: string): string =>
  `${serverUrl.replace(/\/+$/, "")}${oauthPathFor(usersSlug)}/github/callback`

export const buildAuthorizeUrl = ({
  clientId,
  callbackUrl,
  state,
  challenge,
}: {
  clientId: string
  callbackUrl: string
  state: string
  challenge: string
}): string => {
  const url = new URL(GITHUB_AUTHORIZE_URL)
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", callbackUrl)
  // GitHub Apps ignore scopes; offline_access requests an expiring user token
  // and a refresh token. Permissions are configured on the app.
  url.searchParams.set("scope", "offline_access")
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")

  return url.toString()
}

/**
 * Prefer the primary verified address, then any verified address. An account
 * with no verified address is rejected.
 */
export const selectVerifiedEmail = (emails: GithubEmail[]): string | null => {
  const primary = emails.find((entry) => entry.primary && entry.verified)
  if (primary) return primary.email

  const verified = emails.find((entry) => entry.verified)
  return verified?.email ?? null
}

export const isAllowedEmail = (email: string, emails: string[] | ((email: string) => boolean)): boolean => {
  if (typeof emails === "function") return emails(email)

  return emails.some((entry) => entry.toLowerCase() === email.toLowerCase())
}

export const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const serializeCookie = (name: string, value: string, options: CookieOptions = {}): string => {
  const parts = [`${name}=${encodeURIComponent(value)}`]

  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push("HttpOnly")
  if (options.secure) parts.push("Secure")
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)

  return parts.join("; ")
}

export const clearCookie = (name: string, options: CookieOptions = {}): string =>
  serializeCookie(name, "", {
    ...options,
    maxAge: 0,
  })
