import { buildAuthorizeUrl, type GithubEmail, type GithubOrg } from "./oauth.js"

const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token"
const GITHUB_USER_URL = "https://api.github.com/user"
const GITHUB_EMAILS_URL = "https://api.github.com/user/emails"
const GITHUB_ORGS_URL = "https://api.github.com/user/orgs"
const GITHUB_ORG_TEAMS_URL = "https://api.github.com/orgs"

const PAGE_SIZE = 100
const MAX_PAGES = 50

export type GithubUser = {
  id: number
  login: string
  email?: string | null
  name?: string | null
}

export type GithubClient = {
  authorizeUrl(input: { clientId: string; callbackUrl: string; state: string; challenge: string }): string
  exchangeCode(input: {
    clientId: string
    clientSecret: string
    callbackUrl: string
    code: string
    verifier?: string
  }): Promise<string>
  fetchUser(accessToken: string): Promise<GithubUser>
  fetchEmails(accessToken: string): Promise<GithubEmail[]>
  fetchOrgs(accessToken: string): Promise<GithubOrg[]>
  /**
   * Returns true only for an active membership; a 404 is false. The GitHub
   * endpoint includes inherited child-team membership.
   */
  fetchTeamMembership(accessToken: string, org: string, teamSlug: string, username: string): Promise<boolean>
}

const githubHeaders = (token: string) => ({
  Accept: "application/json",
  Authorization: `Bearer ${token}`,
  "User-Agent": "payload-github-auth",
})

const nextLink = (header: string | null): string | null => {
  if (!header) return null

  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/)
    if (match) return match[1]
  }

  return null
}

const fetchPages = async <T>({
  url,
  accessToken,
  resource,
}: {
  url: string
  accessToken: string
  resource: string
}): Promise<T[]> => {
  const entries: T[] = []
  let next: string | null = `${url}?per_page=${PAGE_SIZE}&page=1`

  for (let page = 1; next && page <= MAX_PAGES; page += 1) {
    const response = await fetch(next, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      throw new Error(`GitHub ${resource} request failed: ${response.status}`)
    }

    const data = (await response.json()) as unknown

    if (!Array.isArray(data)) {
      throw new Error(`GitHub ${resource} response was not an array`)
    }

    entries.push(...(data as T[]))

    next = nextLink(response.headers.get("link"))

    if (!next && data.length === PAGE_SIZE) {
      next = `${url}?per_page=${PAGE_SIZE}&page=${page + 1}`
    }
  }

  return entries
}

/**
 * The default GitHub transport. A host or a test can replace it through the
 * `githubClient` option without changing the login flow.
 */
export const createGithubClient = (): GithubClient => ({
  authorizeUrl: ({ clientId, callbackUrl, state, challenge }) =>
    buildAuthorizeUrl({ clientId, callbackUrl, state, challenge }),

  exchangeCode: async ({ clientId, clientSecret, callbackUrl, code, verifier }) => {
    const params = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    })
    if (verifier) params.set("code_verifier", verifier)

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      throw new Error(`GitHub token exchange failed: ${response.status}`)
    }

    const data = (await response.json()) as { access_token?: unknown }
    if (typeof data.access_token !== "string") {
      throw new Error("GitHub token exchange returned no access token")
    }

    return data.access_token
  },

  fetchUser: async (accessToken) => {
    const response = await fetch(GITHUB_USER_URL, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      throw new Error(`GitHub user request failed: ${response.status}`)
    }

    return (await response.json()) as GithubUser
  },

  fetchEmails: async (accessToken) => {
    const response = await fetch(GITHUB_EMAILS_URL, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(10_000),
    })

    if (!response.ok) {
      throw new Error(`GitHub emails request failed: ${response.status}`)
    }

    const emails = (await response.json()) as unknown
    if (!Array.isArray(emails)) {
      throw new Error("GitHub emails response was not an array")
    }

    return emails as GithubEmail[]
  },

  fetchOrgs: (accessToken) =>
    fetchPages<GithubOrg>({
      url: GITHUB_ORGS_URL,
      accessToken,
      resource: "orgs",
    }),

  fetchTeamMembership: async (accessToken, org, teamSlug, username) => {
    const url = `${GITHUB_ORG_TEAMS_URL}/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`
    const response = await fetch(url, {
      headers: githubHeaders(accessToken),
      signal: AbortSignal.timeout(10_000),
    })

    if (response.status === 404) return false

    if (!response.ok) {
      throw new Error(`GitHub team membership request failed: ${response.status}`)
    }

    const data = (await response.json()) as { state?: unknown }

    return data.state === "active"
  },
})
