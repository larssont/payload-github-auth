import { describe, expect, it } from "vitest"

import { createRateLimiter } from "../rate-limit.js"

describe("createRateLimiter", () => {
  it("returns a no-op limiter when disabled", async () => {
    const limiter = createRateLimiter(false)

    expect(await limiter("key")).toBe(false)
    expect(await limiter("key")).toBe(false)
  })

  it("limits after the max in the window", async () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 60_000 })

    expect(await limiter("key")).toBe(false)
    expect(await limiter("key")).toBe(false)
    expect(await limiter("key")).toBe(true)
  })

  it("keeps separate buckets per key", async () => {
    const limiter = createRateLimiter({ max: 1, windowMs: 60_000 })

    expect(await limiter("a")).toBe(false)
    expect(await limiter("b")).toBe(false)
    expect(await limiter("a")).toBe(true)
  })
})
