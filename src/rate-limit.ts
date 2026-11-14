const MAX_ENTRIES = 10_000

export type RateLimitOptions =
  | false
  | {
      windowMs?: number
      max?: number
    }

export type RateLimiter = (key: string) => Promise<boolean>

/**
 * Per-process, in-memory rate limit. The admin login is low traffic; this is a
 * speed bump, not a substitute for the proxy.
 */
export const createRateLimiter = (options: RateLimitOptions): RateLimiter => {
  if (options === false) return async () => false

  const windowMs = options.windowMs ?? 15 * 60_000
  const max = options.max ?? 10
  const hits = new Map<string, { count: number; reset: number }>()

  return async (key) => {
    const now = Date.now()

    if (hits.size > MAX_ENTRIES) {
      for (const [entryKey, entry] of hits) {
        if (entry.reset <= now) hits.delete(entryKey)
      }
    }

    const entry = hits.get(key)
    if (!entry || entry.reset <= now) {
      hits.set(key, { count: 1, reset: now + windowMs })
      return false
    }

    entry.count += 1
    return entry.count > max
  }
}
