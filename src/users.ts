import crypto from "node:crypto"

import type { PayloadRequest, User } from "payload"

import type { GithubUser } from "./github-client.js"
import type { ResolvedGithubAuthConfig } from "./options.js"

type PluginUser = User & {
  role?: string | null
  github_id?: string | null
}

/**
 * Find or create the Payload user behind a GitHub identity.
 *
 * The GitHub id is the identity key. An existing email is linked only when it
 * has no different GitHub id, so a second GitHub account cannot take over a
 * user by matching its email. Denied roles are refused before any write.
 *
 * Do not pass `showHiddenFields: true` to these operations. Payload would then
 * return the hidden `hash` and `salt` fields, and this user object is handed to
 * the host's `onLogin` callback.
 */
export const upsertUser = async ({
  req,
  usersSlug,
  githubUser,
  email,
  defaultRole,
  deniedRoles,
}: {
  req: PayloadRequest
  usersSlug: ResolvedGithubAuthConfig["usersSlug"]
  githubUser: GithubUser
  email: string
  defaultRole: string
  deniedRoles: string[]
}): Promise<User> => {
  const githubId = String(githubUser.id)

  const byGithub = await req.payload.find({
    collection: usersSlug,
    where: { github_id: { equals: githubId } },
    limit: 1,
    overrideAccess: true,
  })

  if (byGithub.docs[0]) {
    const user = byGithub.docs[0] as PluginUser
    if (deniedRoles.includes(user.role ?? "")) {
      throw new Error("Refusing to authenticate a denied role")
    }
    if (user.email !== email) {
      return (await req.payload.update({
        collection: usersSlug,
        id: user.id,
        data: { email },
        overrideAccess: true,
      })) as User
    }
    return user
  }

  const byEmail = await req.payload.find({
    collection: usersSlug,
    where: { email: { equals: email } },
    limit: 1,
    overrideAccess: true,
  })

  if (byEmail.docs[0]) {
    const user = byEmail.docs[0] as PluginUser
    if (deniedRoles.includes(user.role ?? "")) {
      throw new Error("Refusing to link a denied role to GitHub")
    }

    const existingGithubId = user.github_id
    if (existingGithubId && existingGithubId !== githubId) {
      throw new Error("Refusing to relink a user to a different GitHub identity")
    }

    return (await req.payload.update({
      collection: usersSlug,
      id: user.id,
      data: { github_id: githubId },
      overrideAccess: true,
    })) as User
  }

  if (deniedRoles.includes(defaultRole)) {
    throw new Error("Refusing to create a user with a denied role")
  }

  const collectionConfig = req.payload.collections[usersSlug]?.config
  const auth = typeof collectionConfig?.auth === "object" ? collectionConfig.auth : undefined
  const localStrategyEnabled = Boolean(auth && !auth.disableLocalStrategy)

  return (await req.payload.create({
    collection: usersSlug,
    // The collection slug is a runtime option, so the generated data type is
    // not available here. The plugin writes only the fields it owns.
    data: {
      email,
      github_id: githubId,
      role: defaultRole,
      // Payload's local strategy requires a password when it creates a user.
      // GitHub users never use it, so Payload stores only the random hash.
      ...(localStrategyEnabled ? { password: crypto.randomBytes(32).toString("base64url") } : {}),
    } as never,
    overrideAccess: true,
  })) as User
}
