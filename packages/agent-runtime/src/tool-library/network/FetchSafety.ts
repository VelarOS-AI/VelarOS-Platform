import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { AppError } from '@velaros-ai/core/error'

const MaxSafeFetchRedirects = 10

interface SafeFetchOptions {
  lookupIpAddresses?: (hostname: string) => Promise<readonly string[]>
}

function normalizeIpLiteral(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

function readIpv4Octets(value: string): Nullable<[number, number, number, number]> {
  const parts = value.split('.')
  if (parts.length !== 4) return null

  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return NaN
    const value = Number(part)
    return Number.isInteger(value) && value >= 0 && value <= 255 ? value : NaN
  })
  if (octets.some((part) => Number.isNaN(part))) return null

  return octets as [number, number, number, number]
}

function readMappedIpv4(value: string): Nullable<string> {
  const normalized = normalizeIpLiteral(value).toLowerCase()
  const prefix = '::ffff:'
  if (!normalized.startsWith(prefix)) return null
  const candidate = normalized.slice(prefix.length)
  return readIpv4Octets(candidate) ? candidate : null
}

function isBlockedIpv4Address(value: string): boolean {
  const octets = readIpv4Octets(value)
  if (!octets) return false

  const [first, second] = octets
  switch (first) {
    case 127:
      return false
    case 10:
      return true
  }
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  if (first === 169 && second === 254) return true
  if (first === 100 && second >= 64 && second <= 127) return true
  if (first === 0 && octets.every((part) => part === 0)) return true
  if (first === 224 && second === 0 && octets[2] === 0) return true

  return false
}

function isBlockedIpv6Address(value: string): boolean {
  const normalized = normalizeIpLiteral(value).toLowerCase()
  switch (normalized) {
    case '::1':
      return false
    case '::':
      return true
  }

  const mappedIpv4 = readMappedIpv4(normalized)
  if (mappedIpv4) return isBlockedIpv4Address(mappedIpv4)

  return (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith('ff02:')
  )
}

function isBlockedFetchIpAddress(value: string): boolean {
  const normalized = normalizeIpLiteral(value)
  const mappedIpv4 = readMappedIpv4(normalized)
  if (mappedIpv4) return isBlockedIpv4Address(mappedIpv4)

  switch (isIP(normalized)) {
    case 4:
      return isBlockedIpv4Address(normalized)
    case 6:
      return isBlockedIpv6Address(normalized)
    default:
      return false
  }
}

function parseSafeHttpUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (error) {
    throw new AppError('VALIDATION', 'Fetch URL must be a valid absolute URL.', error, {
      url: rawUrl,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError('VALIDATION', 'Fetch URL must use http or https.', undefined, {
      url: rawUrl,
      protocol: parsed.protocol,
    })
  }

  return parsed
}

async function defaultLookupIpAddresses(hostname: string): Promise<string[]> {
  const resolved = await lookup(hostname, { all: true, verbatim: true })
  return resolved.map((entry) => entry.address)
}

async function assertSafeHttpFetchUrl(
  rawUrl: string,
  options: SafeFetchOptions = {}
): Promise<URL> {
  const parsed = parseSafeHttpUrl(rawUrl)
  const hostname = normalizeIpLiteral(parsed.hostname)

  if (isIP(hostname)) {
    if (isBlockedFetchIpAddress(hostname)) {
      throw new AppError(
        'VALIDATION',
        `refusing to fetch internal address ${hostname} (direct IP target)`,
        undefined,
        { url: rawUrl, hostname }
      )
    }
    return parsed
  }

  const lookupIpAddresses = options.lookupIpAddresses ?? defaultLookupIpAddresses
  const addresses = await lookupIpAddresses(hostname)
  const blockedAddress = addresses.find((address) => isBlockedFetchIpAddress(address))
  if (blockedAddress) {
    throw new AppError(
      'VALIDATION',
      `refusing to fetch internal address ${hostname} (resolves to ${blockedAddress})`,
      undefined,
      { url: rawUrl, hostname, address: blockedAddress }
    )
  }

  return parsed
}

async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  options: SafeFetchOptions = {}
): Promise<Response> {
  let current = await assertSafeHttpFetchUrl(rawUrl, options)

  for (let redirects = 0; redirects <= MaxSafeFetchRedirects; redirects += 1) {
    const response = await fetch(current.href, {
      ...init,
      redirect: 'manual',
    })
    const location = response.headers.get('location')
    const isRedirect = response.status >= 300 && response.status < 400 && !!location
    if (!isRedirect) return response

    current = await assertSafeHttpFetchUrl(new URL(location, current).href, options)
  }

  throw new AppError('VALIDATION', `Fetch URL redirected more than ${MaxSafeFetchRedirects} times.`, undefined, {
    url: rawUrl,
  })
}

export { assertSafeHttpFetchUrl, isBlockedFetchIpAddress, safeFetch }
export type { SafeFetchOptions }
