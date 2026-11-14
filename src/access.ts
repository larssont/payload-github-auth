import type { Access, FieldAccess } from "payload"

export type GithubAuthAccessOptions = {
  adminRole?: string
}

const isAdmin = (user: unknown, adminRole: string): boolean => (user as { role?: string } | null)?.role === adminRole

/**
 * Access helpers for the users collection the plugin manages. The host keeps
 * ownership of its collection; these save it from reimplementing the admin and
 * self checks with the same role name.
 */
export const createGithubAuthAccess = ({
  adminRole = "admin",
}: GithubAuthAccessOptions = {}): {
  adminOnly: Access
  adminField: FieldAccess
  selfOrAdmin: Access
} => ({
  adminOnly: ({ req }) => isAdmin(req.user, adminRole),
  adminField: ({ req }) => isAdmin(req.user, adminRole),
  selfOrAdmin: ({ req }) => {
    if (!req.user) return false
    if (isAdmin(req.user, adminRole)) return true
    return { id: { equals: req.user.id } }
  },
})
