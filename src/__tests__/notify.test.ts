import { describe, expect, it, vi } from "vitest"

import { sendLoginEmail } from "../notify.js"

const makePayload = () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
})

describe("sendLoginEmail", () => {
  it("sends the account, time, IP and browser", async () => {
    const payload = makePayload()

    await sendLoginEmail({
      payload,
      email: "admin@example.com",
      ip: "203.0.113.7",
      userAgent: "Firefox/141",
      now: new Date("2026-11-12T10:00:00.000Z"),
    })

    expect(payload.sendEmail).toHaveBeenCalledTimes(1)
    const message = payload.sendEmail.mock.calls[0][0]

    expect(message.to).toBe("admin@example.com")
    expect(message.subject).toBe("New sign-in to the CMS")
    expect(message.text).toContain("admin@example.com")
    expect(message.text).toContain("2026-11-12T10:00:00.000Z")
    expect(message.text).toContain("203.0.113.7")
    expect(message.text).toContain("Firefox/141")
  })

  it("never includes a session token", async () => {
    const payload = makePayload()

    await sendLoginEmail({
      payload,
      email: "admin@example.com",
      ip: "203.0.113.7",
      userAgent: "Firefox/141",
    })

    const message = payload.sendEmail.mock.calls[0][0]

    expect(message.text).not.toContain("payload-token")
    expect(message.text).not.toContain("token=")
  })

  it("falls back to unknown when the browser is missing", async () => {
    const payload = makePayload()

    await sendLoginEmail({
      payload,
      email: "admin@example.com",
      ip: "203.0.113.7",
    })

    const message = payload.sendEmail.mock.calls[0][0]

    expect(message.text).toContain("Browser: unknown")
  })

  it("uses a custom app name", async () => {
    const payload = makePayload()

    await sendLoginEmail({
      payload,
      email: "admin@example.com",
      ip: "203.0.113.7",
      appName: "Acme Admin",
    })

    const message = payload.sendEmail.mock.calls[0][0]

    expect(message.subject).toBe("New sign-in to Acme Admin")
    expect(message.text).toContain("A new sign-in to Acme Admin succeeded.")
  })
})
