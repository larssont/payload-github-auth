import {
  type AuthenticatedUser,
  createAuthToken,
  type PayloadRequest,
  type SanitizedCollectionConfig,
  type User,
} from "payload"

/**
 * Mint a normal Payload session for a GitHub-authenticated user.
 *
 * `createAuthToken` is Payload's own login helper: it adds the session to the
 * user, signs the JWT with the collection's token expiration, and returns the
 * token. The admin is authenticated by the plugin's `github-jwt` strategy.
 */
export const createPayloadSession = async ({
  user,
  collectionConfig,
  req,
}: {
  user: User
  collectionConfig: SanitizedCollectionConfig
  req: PayloadRequest
}): Promise<{ token: string; maxAge: number }> => {
  const { token } = await createAuthToken({
    collectionConfig,
    email: user.email ?? "",
    req,
    user: user as AuthenticatedUser,
  })

  const auth = typeof collectionConfig.auth === "object" ? collectionConfig.auth : undefined

  return { token, maxAge: auth?.tokenExpiration ?? 7200 }
}
