import dns from 'dns';
import net from 'net';

/**
 * Validates whether an IPv4 address is in a private, loopback, link-local,
 * or reserved range according to IETF specifications.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // invalid IPv4 format treated as unsafe
  }

  const [a, b] = parts;

  // 0.0.0.0/8 - "This network"
  if (a === 0) return true;

  // 10.0.0.0/8 - Private-Use
  if (a === 10) return true;

  // 100.64.0.0/10 - Shared Address Space (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;

  // 127.0.0.0/8 - Loopback
  if (a === 127) return true;

  // 169.254.0.0/16 - Link-Local (Cloud metadata services: AWS, GCP, Azure, DigitalOcean)
  if (a === 169 && b === 254) return true;

  // 172.16.0.0/12 - Private-Use
  if (a === 172 && b >= 16 && b <= 31) return true;

  // 192.0.0.0/24 - IETF Protocol Assignments
  if (a === 192 && b === 0 && parts[2] === 0) return true;

  // 192.0.2.0/24 - TEST-NET-1
  if (a === 192 && b === 0 && parts[2] === 2) return true;

  // 192.88.99.0/24 - 6to4 Relay Anycast
  if (a === 192 && b === 88 && parts[2] === 99) return true;

  // 192.168.0.0/16 - Private-Use
  if (a === 192 && b === 168) return true;

  // 198.18.0.0/15 - Benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;

  // 198.51.100.0/24 - TEST-NET-2
  if (a === 198 && b === 51 && parts[2] === 100) return true;

  // 203.0.113.0/24 - TEST-NET-3
  if (a === 203 && b === 0 && parts[2] === 113) return true;

  // 224.0.0.0/4 - Multicast
  if (a >= 224 && a <= 239) return true;

  // 240.0.0.0/4 - Reserved for Future Use
  if (a >= 240) return true;

  return false;
}

/**
 * Validates whether an IPv6 address is in a private, loopback, link-local,
 * or reserved range. Handles IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1).
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim();

  // Loopback (::1) and Unspecified (::)
  if (normalized === '::1' || normalized === '::') return true;

  // IPv4-mapped IPv6 (::ffff:w.x.y.z)
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice(7);
    if (net.isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part);
    }
  }

  // Unique Local Address (ULA) - fc00::/7 (fc00:: through fdff::)
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return true;

  // Link-Local Unicast - fe80::/10 (fe80:: through febf::)
  if (/^fe[89ab][0-9a-f]:/i.test(normalized)) return true;

  // Multicast - ff00::/8
  if (normalized.startsWith('ff')) return true;

  // Documentation - 2001:db8::/32
  if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0db8:')) return true;

  // Discard-only - 100::/64
  if (normalized.startsWith('100::')) return true;

  return false;
}

/**
 * Combined check for any IP address.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // Not a recognized IP; untrusted
}

/**
 * List of known internal / forbidden hostname suffixes and names.
 */
const FORBIDDEN_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /\.home$/i,
  /\.corp$/i,
  /\.test$/i,
  /\.example$/i,
  /\.invalid$/i,
  /^metadata\.google\.internal$/i,
  /^instance-data$/i,
  /^metadata$/i,
];

/**
 * Validates whether a hostname is safe for outbound proxy requests.
 */
export function isForbiddenHostname(hostname: string): boolean {
  const cleanHost = hostname.toLowerCase().trim().replace(/\.$/, '');

  for (const pattern of FORBIDDEN_HOST_PATTERNS) {
    if (pattern.test(cleanHost)) return true;
  }

  return false;
}

export interface UrlValidationResult {
  safe: boolean;
  error?: string;
  url?: URL;
  resolvedIp?: string;
}

/**
 * Validates a target URL against SSRF, dangerous protocols, private networks,
 * and internal DNS targets. Performs DNS resolution to prevent DNS-rebinding attacks.
 */
export async function validateSafeUrl(
  rawUrl: string,
  options?: {
    allowHttp?: boolean;
    allowedHostRegex?: RegExp;
    skipDnsLookup?: boolean;
  }
): Promise<UrlValidationResult> {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, error: 'URL is required' };
  }

  if (rawUrl.length > 2048) {
    return { safe: false, error: 'URL exceeds maximum length of 2048 characters' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, error: 'Malformed or invalid URL' };
  }

  // Protocol check
  const protocol = parsed.protocol.toLowerCase();
  const allowedProtocols = options?.allowHttp ? ['https:', 'http:'] : ['https:', 'http:'];
  if (!allowedProtocols.includes(protocol)) {
    return { safe: false, error: `Protocol "${parsed.protocol}" is not allowed` };
  }

  // Reject credentials in URL (e.g. http://user:pass@evil.com/)
  if (parsed.username || parsed.password) {
    return { safe: false, error: 'Credentials in URL are forbidden' };
  }

  // Port check: only 80 and 443 permitted
  const port = parsed.port ? parseInt(parsed.port, 10) : protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) {
    return { safe: false, error: `Port ${port} is not allowed. Only standard ports (80, 443) are supported.` };
  }

  const hostname = parsed.hostname.toLowerCase().trim();

  if (!hostname) {
    return { safe: false, error: 'Hostname cannot be empty' };
  }

  // Check forbidden hostname patterns
  if (isForbiddenHostname(hostname)) {
    return { safe: false, error: `Access to hostname "${hostname}" is forbidden` };
  }

  // If hostname is an IP literal, check directly
  const ipVer = net.isIP(hostname);
  if (ipVer !== 0) {
    if (isPrivateOrReservedIp(hostname)) {
      return { safe: false, error: `Access to private/reserved IP "${hostname}" is forbidden` };
    }
    return { safe: true, url: parsed, resolvedIp: hostname };
  }

  // Check custom allowed host regex if specified
  if (options?.allowedHostRegex && !options.allowedHostRegex.test(hostname)) {
    return { safe: false, error: `Hostname "${hostname}" is not in the allowed domain list` };
  }

  // Perform DNS resolution to prevent DNS rebinding
  if (!options?.skipDnsLookup) {
    try {
      const records = await dns.promises.lookup(hostname, { all: true });
      if (!records || records.length === 0) {
        return { safe: false, error: `Could not resolve hostname "${hostname}"` };
      }

      for (const record of records) {
        if (isPrivateOrReservedIp(record.address)) {
          return {
            safe: false,
            error: `Hostname "${hostname}" resolves to forbidden IP ${record.address}`,
          };
        }
      }

      return { safe: true, url: parsed, resolvedIp: records[0].address };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { safe: false, error: `DNS lookup failed for "${hostname}": ${msg}` };
    }
  }

  return { safe: true, url: parsed };
}

/**
 * Validates anime slug syntax (alphanumeric, dashes, underscores, 1-128 chars).
 * Prevents directory traversal and injection.
 */
export function isValidSlug(slug: unknown): slug is string {
  if (typeof slug !== 'string') return false;
  const trimmed = slug.trim();
  if (trimmed.length < 1 || trimmed.length > 128) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

/**
 * Validates episode number / identifier.
 */
export function isValidEpisodeNum(ep: unknown): ep is string {
  if (typeof ep !== 'string' && typeof ep !== 'number') return false;
  const str = String(ep).trim();
  if (str.length < 1 || str.length > 32) return false;
  return /^[a-zA-Z0-9._-]+$/.test(str);
}

/**
 * Parses a string into a bounded integer, returning fallback or null on failure.
 */
export function parseBoundedInt(
  value: string | null | undefined,
  min: number,
  max: number,
  fallback?: number
): number | null {
  if (value === null || value === undefined || value.trim() === '') {
    return fallback !== undefined ? fallback : null;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || !Number.isFinite(parsed)) {
    return fallback !== undefined ? fallback : null;
  }
  if (parsed < min || parsed > max) {
    return fallback !== undefined ? fallback : null;
  }
  return parsed;
}

/**
 * Sanitizes a filename, preventing directory traversal and dangerous characters.
 */
export function sanitizeFilename(name: string, defaultName = 'video'): string {
  if (!name || typeof name !== 'string') return defaultName;
  const clean = name
    .replace(/[/\\]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_+/g, '_')
    .trim();
  return clean.slice(0, 120) || defaultName;
}

/**
 * Allowed content types for proxying streaming media.
 */
export const ALLOWED_MEDIA_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'video/mp2t',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'audio/ogg',
  'text/vtt',
  'text/plain',
  'application/x-subrip',
  'application/octet-stream', // Used by some CDNs for .ts video segments
  'image/jpeg',
  'image/png',
  'image/webp',
];

/**
 * Verifies if upstream Content-Type is acceptable media or streaming data.
 */
export function isAllowedContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const lower = contentType.toLowerCase().split(';')[0].trim();
  return ALLOWED_MEDIA_CONTENT_TYPES.includes(lower);
}
