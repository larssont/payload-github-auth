import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
  buildAuthorizeUrl,
  callbackUrlFor,
  clearCookie,
  createPkce,
  createState,
  isAllowedEmail,
  oauthPathFor,
  safeEqual,
  selectVerifiedEmail,
  serializeCookie,
} from "../oauth.js"

describe("createState", () => {
  it("returns a unique base64url value", () => {
    const first = createState()
    const second = createState()

    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe("createPkce", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = createPkce()
    const expected = createHash("sha256").update(verifier).digest("base64url")

    expect(challenge).toBe(expected)
  })
})

describe("oauthPathFor", () => {
  it("derives the OAuth path from the users slug", () => {
    expect(oauthPathFor("admins")).toBe("/api/admins/oauth")
  })
})

describe("callbackUrlFor", () => {
  it("trims trailing slashes", () => {
    expect(callbackUrlFor("http://localhost:20300/", "users")).toBe(
      "http://localhost:20300/api/users/oauth/github/callback",
    )
  })

  it("uses the configured users slug", () => {
    expect(callbackUrlFor("http://localhost:20300", "admins")).toBe(
      "http://localhost:20300/api/admins/oauth/github/callback",
    )
  })
})

describe("buildAuthorizeUrl", () => {
  it("includes the exact callback, scope, state and PKCE", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client",
        callbackUrl: "http://localhost:20300/api/users/oauth/github/callback",
        state: "state",
        challenge: "challenge",
      }),
    )

    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize")
    expect(url.searchParams.get("client_id")).toBe("client")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:20300/api/users/oauth/github/callback")
    expect(url.searchParams.get("scope")).toBe("offline_access")
    expect(url.searchParams.get("state")).toBe("state")
    expect(url.searchParams.get("code_challenge")).toBe("challenge")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
  })
})

describe("selectVerifiedEmail", () => {
  it("prefers the primary verified address", () => {
    expect(
      selectVerifiedEmail([
        { email: "secondary@example.com", primary: false, verified: true },
        { email: "primary@example.com", primary: true, verified: true },
      ]),
    ).toBe("primary@example.com")
  })

  it("falls back to any verified address", () => {
    expect(selectVerifiedEmail([{ email: "verified@example.com", primary: false, verified: true }])).toBe(
      "verified@example.com",
    )
  })

  it("rejects an unverified address", () => {
    expect(selectVerifiedEmail([{ email: "unverified@example.com", primary: true, verified: false }])).toBeNull()
  })

  it("returns null for an empty list", () => {
    expect(selectVerifiedEmail([])).toBeNull()
  })
})

describe("isAllowedEmail", () => {
  it("matches case-insensitively", () => {
    expect(isAllowedEmail("Admin@Example.com", ["admin@example.com"])).toBe(true)
  })

  it("rejects an address that is not on the list", () => {
    expect(isAllowedEmail("other@example.com", ["admin@example.com"])).toBe(false)
  })

  it("rejects every address when the list is empty", () => {
    expect(isAllowedEmail("any@example.com", [])).toBe(false)
  })

  it("uses a function email rule", () => {
    expect(isAllowedEmail("admin@example.com", (email) => email.endsWith("@example.com"))).toBe(true)
  })
})

describe("safeEqual", () => {
  it("compares equal values", () => {
    expect(safeEqual("state", "state")).toBe(true)
  })

  it("rejects different values", () => {
    expect(safeEqual("state", "other")).toBe(false)
  })

  it("rejects different lengths", () => {
    expect(safeEqual("state", "state!")).toBe(false)
  })
})

describe("serializeCookie", () => {
  it("sets the expected flags", () => {
    expect(
      serializeCookie("name", "value", {
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        path: "/",
        maxAge: 600,
      }),
    ).toBe("name=value; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax")
  })

  it("clears with maxAge 0", () => {
    expect(clearCookie("name", { path: "/" })).toBe("name=; Max-Age=0; Path=/")
  })
})
