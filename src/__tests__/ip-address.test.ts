import { describe, expect, it } from "vitest"

import { clientIp, type IpAddressOptions, rateLimitKey, resolveIpAddressOptions } from "../ip-address.js"

const options = (overrides: IpAddressOptions = {}) => resolveIpAddressOptions(overrides)

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) })

describe("clientIp", () => {
  it("uses a single x-forwarded-for value", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), options())).toBe("203.0.113.7")
  })

  it("walks the x-forwarded-for chain from the right and skips trusted proxies", () => {
    expect(
      clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), options({ trustedProxies: ["10.0.0.0/8"] })),
    ).toBe("203.0.113.7")
  })

  it("ignores a spoofed leftmost value", () => {
    expect(
      clientIp(
        req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 10.0.0.1" }),
        options({ trustedProxies: ["10.0.0.0/8"] }),
      ),
    ).toBe("203.0.113.7")
  })

  it("fails closed when a chain has multiple values and no trusted proxies", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }), options())).toBe("unknown")
  })

  it("uses x-real-ip and cf-connecting-ip", () => {
    expect(clientIp(req({ "x-real-ip": "203.0.113.8" }), options({ headers: ["x-real-ip"] }))).toBe("203.0.113.8")
    expect(clientIp(req({ "cf-connecting-ip": "203.0.113.9" }), options({ headers: ["cf-connecting-ip"] }))).toBe(
      "203.0.113.9",
    )
  })

  it("uses the first valid header in order", () => {
    expect(
      clientIp(
        req({ "x-real-ip": "203.0.113.8", "x-forwarded-for": "203.0.113.7" }),
        options({ headers: ["x-real-ip", "x-forwarded-for"] }),
      ),
    ).toBe("203.0.113.8")
  })

  it("falls back to the next header when the first is invalid", () => {
    expect(
      clientIp(
        req({ "x-real-ip": "not-an-ip", "x-forwarded-for": "203.0.113.7" }),
        options({ headers: ["x-real-ip", "x-forwarded-for"] }),
      ),
    ).toBe("203.0.113.7")
  })

  it("returns unknown without a usable header", () => {
    expect(clientIp(req({}), options())).toBe("unknown")
    expect(clientIp(req({ "x-forwarded-for": "not-an-ip" }), options())).toBe("unknown")
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.7" }), options({ headers: [] }))).toBe("unknown")
  })

  it("converts an IPv4-mapped IPv6 address to IPv4", () => {
    expect(clientIp(req({ "x-forwarded-for": "::ffff:192.0.2.1" }), options())).toBe("192.0.2.1")
  })

  it("returns unknown when every address is a trusted proxy", () => {
    expect(
      clientIp(req({ "x-forwarded-for": "10.0.0.1, 10.0.0.2" }), options({ trustedProxies: ["10.0.0.0/8"] })),
    ).toBe("unknown")
  })

  it("supports IPv6 trusted proxies", () => {
    expect(
      clientIp(req({ "x-forwarded-for": "2001:db9::1, 2001:db8::2" }), options({ trustedProxies: ["2001:db8::/32"] })),
    ).toBe("2001:db9::1")
  })
})

describe("rateLimitKey", () => {
  it("keeps IPv4 addresses as-is", () => {
    expect(rateLimitKey("203.0.113.7", 64)).toBe("203.0.113.7")
  })

  it("groups IPv6 addresses by /64", () => {
    expect(rateLimitKey("2001:db8:1:2::1", 64)).toBe(rateLimitKey("2001:db8:1:2::2", 64))
    expect(rateLimitKey("2001:db8:1:2::1", 64)).not.toBe(rateLimitKey("2001:db8:1:3::1", 64))
  })

  it("groups a wider /56 prefix", () => {
    expect(rateLimitKey("2001:db8:1:2::1", 56)).toBe(rateLimitKey("2001:db8:1:3::1", 56))
  })

  it("keeps /128 addresses separate", () => {
    expect(rateLimitKey("2001:db8:1:2::1", 128)).not.toBe(rateLimitKey("2001:db8:1:2::2", 128))
  })

  it("groups all IPv6 addresses at /0", () => {
    expect(rateLimitKey("2001:db8::1", 0)).toBe(rateLimitKey("2001:db9::1", 0))
  })

  it("returns unknown for an unknown or invalid address", () => {
    expect(rateLimitKey("unknown", 64)).toBe("unknown")
    expect(rateLimitKey("not-an-ip", 64)).toBe("unknown")
  })
})
