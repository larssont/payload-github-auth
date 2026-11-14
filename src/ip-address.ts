import ipaddr from "ipaddr.js"

export type IpAddressOptions = {
  /** Headers to read, in order. Default: `["x-forwarded-for"]`. */
  headers?: string[]
  /** Proxy CIDRs to skip when parsing `x-forwarded-for`. Default: `[]`. */
  trustedProxies?: string[]
  /** IPv6 prefix length used for the rate-limit key. Default: `64`. */
  ipv6Subnet?: number
}

export type ResolvedIpAddressOptions = {
  headers: string[]
  trustedProxies: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>
  ipv6Subnet: number
}

const DEFAULT_HEADERS = ["x-forwarded-for"]
const DEFAULT_IPV6_SUBNET = 64

export const resolveIpAddressOptions = (options: IpAddressOptions = {}): ResolvedIpAddressOptions => {
  const headers = options.headers ?? DEFAULT_HEADERS

  if (!Array.isArray(headers) || headers.some((header) => typeof header !== "string" || !header.trim())) {
    throw new Error("GitHub auth ipAddress.headers must be a list of header names")
  }

  const ipv6Subnet = options.ipv6Subnet ?? DEFAULT_IPV6_SUBNET

  if (!Number.isInteger(ipv6Subnet) || ipv6Subnet < 0 || ipv6Subnet > 128) {
    throw new Error("GitHub auth ipAddress.ipv6Subnet must be an integer between 0 and 128")
  }

  const trustedProxies = (options.trustedProxies ?? []).map((cidr) => {
    try {
      return ipaddr.parseCIDR(cidr) as [ipaddr.IPv4 | ipaddr.IPv6, number]
    } catch {
      throw new Error(`GitHub auth ipAddress.trustedProxies contains an invalid CIDR: ${cidr}`)
    }
  })

  return {
    headers: headers.map((header) => header.trim().toLowerCase()),
    trustedProxies,
    ipv6Subnet,
  }
}

const parseAddress = (value: string): ipaddr.IPv4 | ipaddr.IPv6 | null => {
  const trimmed = value.trim()

  if (!trimmed) return null

  try {
    const address = ipaddr.parse(trimmed)

    if (address.kind() === "ipv6" && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (address as ipaddr.IPv6).toIPv4Address()
    }

    return address
  } catch {
    return null
  }
}

const isTrusted = (
  address: ipaddr.IPv4 | ipaddr.IPv6,
  trustedProxies: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>,
): boolean => trustedProxies.some(([proxy, prefix]) => proxy.kind() === address.kind() && address.match(proxy, prefix))

const forwardedFor = (value: string, trustedProxies: Array<[ipaddr.IPv4 | ipaddr.IPv6, number]>): string | null => {
  const addresses = value
    .split(",")
    .map(parseAddress)
    .filter((address): address is ipaddr.IPv4 | ipaddr.IPv6 => address !== null)

  if (addresses.length === 0) return null

  if (trustedProxies.length === 0) {
    // A single value is the common "proxy overwrites the header" case. A
    // multi-value chain without trusted proxies is ambiguous, so fail closed.
    return addresses.length === 1 ? addresses[0].toString() : null
  }

  for (let index = addresses.length - 1; index >= 0; index -= 1) {
    if (!isTrusted(addresses[index], trustedProxies)) {
      return addresses[index].toString()
    }
  }

  return null
}

/**
 * Resolve the client IP from the configured headers. Returns `"unknown"` when
 * no trustworthy address is available; callers then share one rate-limit
 * bucket.
 */
export const clientIp = (req: { headers: Headers }, options: ResolvedIpAddressOptions): string => {
  for (const header of options.headers) {
    const value = req.headers.get(header)
    if (!value) continue

    if (header === "x-forwarded-for") {
      const address = forwardedFor(value, options.trustedProxies)
      if (address) return address
      continue
    }

    const address = parseAddress(value)
    if (address) return address.toString()
  }

  return "unknown"
}

/**
 * Build the rate-limit key. IPv4 addresses are used as-is; IPv6 addresses are
 * masked to `ipv6Subnet` so a client cannot rotate through its own prefix.
 */
export const rateLimitKey = (ip: string, ipv6Subnet: number): string => {
  if (ip === "unknown") return "unknown"

  const address = parseAddress(ip)
  if (!address) return "unknown"
  if (address.kind() === "ipv4") return address.toString()

  const bytes = address.toByteArray()

  for (let index = 0; index < bytes.length; index += 1) {
    const bitStart = index * 8

    if (bitStart >= ipv6Subnet) {
      bytes[index] = 0
    } else if (bitStart + 8 > ipv6Subnet) {
      const keep = ipv6Subnet - bitStart
      bytes[index] &= (0xff << (8 - keep)) & 0xff
    }
  }

  return `${Buffer.from(bytes).toString("hex")}/${ipv6Subnet}`
}
