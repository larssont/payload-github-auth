import type { Payload } from "payload"

/**
 * Notifies the account owner about a successful CMS sign-in.
 *
 * The GitHub callback mints the session with Payload's `createAuthToken`, so
 * Payload's `afterLogin` hook never runs. This is called from the callback
 * instead. The body carries no token: an email is a weaker channel than the
 * cookie.
 */
export const sendLoginEmail = async ({
  payload,
  email,
  ip,
  userAgent,
  appName = "CMS",
  now = new Date(),
}: {
  payload: Pick<Payload, "sendEmail">
  email: string
  ip: string
  userAgent?: string | null
  appName?: string
  now?: Date
}): Promise<void> => {
  const label = appName === "CMS" ? "the CMS" : appName
  const lines = [
    `A new sign-in to ${label} succeeded.`,
    "",
    `Account: ${email}`,
    "Method: GitHub",
    `Time: ${now.toISOString()}`,
    `IP: ${ip}`,
    `Browser: ${userAgent || "unknown"}`,
    "",
    "If this was not you, sign out, revoke the session and rotate the GitHub credentials.",
  ]

  await payload.sendEmail({
    to: email,
    subject: `New sign-in to ${label}`,
    text: lines.join("\n"),
  })
}
