import type { CollectionConfig, CollectionSlug, Payload, PayloadRequest, User } from "payload"

type GithubSession = {
  id: string
  createdAt?: string | Date | null
  expiresAt: string | Date
}

export type SessionUser = Omit<User, "collection"> & {
  sessions?: GithubSession[] | null
}

export type SessionStore = {
  find(user: SessionUser, sid: string): boolean
  revoke(user: SessionUser, sid: string, collectionConfig: CollectionConfig): Promise<void>
  revokeAll(user: SessionUser, collectionConfig: CollectionConfig): Promise<void>
  extend(user: SessionUser, sid: string, collectionConfig: CollectionConfig): Promise<void>
}

const tokenExpirationFor = (collectionConfig: CollectionConfig): number => {
  const auth = typeof collectionConfig.auth === "object" ? collectionConfig.auth : undefined
  return auth?.tokenExpiration ?? 7200
}

/**
 * The session mutation seam for the custom strategy and the logout and refresh
 * hooks. Payload's `createAuthToken` creates sessions; this store handles the
 * operations Payload does not export.
 */
export const createSessionStore = ({ payload, req }: { payload: Payload; req?: PayloadRequest }): SessionStore => {
  const write = async (
    user: SessionUser,
    collectionConfig: CollectionConfig,
    sessions: GithubSession[],
  ): Promise<void> => {
    await payload.db.updateOne({
      id: user.id,
      collection: collectionConfig.slug as CollectionSlug,
      data: { sessions },
      req,
      returning: false,
    })
  }

  return {
    find: (user, sid) => (user.sessions ?? []).some((session) => session.id === sid),

    revoke: async (user, sid, collectionConfig) => {
      const sessions = (user.sessions ?? []).filter((session) => session.id !== sid)
      await write(user, collectionConfig, sessions)
    },

    revokeAll: async (user, collectionConfig) => {
      await write(user, collectionConfig, [])
    },

    extend: async (user, sid, collectionConfig) => {
      const expiresAt = new Date(Date.now() + tokenExpirationFor(collectionConfig) * 1000).toISOString()
      const sessions = (user.sessions ?? []).map((session) =>
        session.id === sid ? { ...session, expiresAt } : session,
      )
      await write(user, collectionConfig, sessions)
    },
  }
}
