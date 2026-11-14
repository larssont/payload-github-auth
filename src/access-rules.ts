import type { GithubOrg, GithubTeam } from "./oauth.js"
import { isAllowedEmail } from "./oauth.js"

/**
 * A single access rule. A rule is one check, not a combination: use `match` to
 * combine several rules.
 */
export type GithubAccessRule =
  | { email: string[] | ((email: string) => boolean) }
  | { org: string | string[] }
  | { team: string | string[] }

/**
 * One rule, a shorthand list (matched with "any"), or an explicit rule set.
 */
export type GithubAccessConfig =
  | GithubAccessRule
  | GithubAccessRule[]
  | { match?: "any" | "all"; rules: GithubAccessRule[] }

export type ResolvedGithubAccess = {
  match: "any" | "all"
  rules: GithubAccessRule[]
}

const RULE_KEYS = ["email", "org", "team"] as const

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const validateRule = (value: unknown, index: number): GithubAccessRule => {
  if (!isObject(value)) {
    throw new Error(`GitHub auth access rule ${index} must be an object`)
  }

  const keys = RULE_KEYS.filter((key) => key in value)

  if (keys.length !== 1) {
    throw new Error(`GitHub auth access rule ${index} must set exactly one of email, org, or team`)
  }

  const key = keys[0]
  const ruleValue = value[key]

  if (key === "email") {
    if (typeof ruleValue === "function") return value as unknown as GithubAccessRule
    if (!Array.isArray(ruleValue) || ruleValue.length === 0) {
      throw new Error(`GitHub auth access rule ${index} email must be a non-empty string list or a function`)
    }
    if (ruleValue.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error(`GitHub auth access rule ${index} email must contain only non-empty strings`)
    }

    return value as unknown as GithubAccessRule
  }

  const entries = Array.isArray(ruleValue) ? ruleValue : [ruleValue]

  if (entries.length === 0 || entries.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`GitHub auth access rule ${index} ${key} must be a non-empty string or string list`)
  }

  if (
    key === "team" &&
    entries.some((entry) => typeof entry === "string" && !/^[^/\s]+\/[^/\s]+$/.test(entry.trim()))
  ) {
    throw new Error(`GitHub auth access rule ${index} team must be "org/team-slug"`)
  }

  return value as unknown as GithubAccessRule
}

/**
 * Normalize the public `access` option into one shape. A single rule and a
 * shorthand list default to `match: "any"`.
 */
export const normalizeAccess = (access: GithubAccessConfig): ResolvedGithubAccess => {
  if (Array.isArray(access)) {
    if (access.length === 0) throw new Error("GitHub auth requires at least one access rule")

    return { match: "any", rules: access.map(validateRule) }
  }

  if (isObject(access) && "rules" in access) {
    const rules = access.rules

    if (!Array.isArray(rules) || rules.length === 0) {
      throw new Error("GitHub auth requires at least one access rule")
    }

    const match = access.match ?? "any"

    if (match !== "any" && match !== "all") {
      throw new Error('GitHub auth access match must be "any" or "all"')
    }

    return { match, rules: rules.map(validateRule) }
  }

  return { match: "any", rules: [validateRule(access, 0)] }
}

export const accessNeedsOrgList = (access: ResolvedGithubAccess): boolean => access.rules.some((rule) => "org" in rule)

const asList = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value])

/**
 * The distinct `org/team-slug` values from the team rules.
 */
export const teamRulesFor = (access: ResolvedGithubAccess): string[] => {
  const teams = access.rules.flatMap((rule) => ("team" in rule ? asList(rule.team) : []))

  return [...new Set(teams.map((team) => team.trim().toLowerCase()))]
}

const normalizeTeam = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")

/**
 * Evaluate every rule and combine the results with `match`. A rule that cannot
 * be evaluated is the caller's problem: the callback fetches the data first and
 * fails closed if GitHub returns an error.
 */
export const isAllowedAccess = ({
  access,
  email,
  orgs = [],
  teams = [],
}: {
  access: ResolvedGithubAccess
  email: string
  orgs?: GithubOrg[]
  teams?: GithubTeam[]
}): boolean => {
  const results = access.rules.map((rule) => {
    if ("email" in rule) return isAllowedEmail(email, rule.email)

    if ("org" in rule) {
      const allowed = asList(rule.org).map((entry) => entry.trim().toLowerCase())
      return orgs.some((org) => allowed.includes(org.login.toLowerCase()))
    }

    const allowed = asList(rule.team).map(normalizeTeam)
    return teams.some((team) => allowed.includes(normalizeTeam(`${team.organization.login}/${team.slug}`)))
  })

  return access.match === "all" ? results.every(Boolean) : results.some(Boolean)
}
