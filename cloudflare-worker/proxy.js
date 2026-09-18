/* eslint-disable */
/**
 * Anikoto Proxy — Cloudflare Worker
 *
 * Secure proxy for HLS streaming media (manifests, video segments, subtitles)
 * with Referer spoofing and SSRF protection.
 *
 * Security features:
 *  - SSRF protection (private IP & reserved range blocking, metadata service blocking)
 *  - Controlled manual redirect following (max 3 hops, validated per hop)
 *  - Media-only content type enforcement (rejects HTML, scripts, executables)
 *  - Manifest text buffer limit (2MB max)
 *  - Streaming passthrough for media chunks (constant O(1) memory)
 *  - Full Range / Content-Range forwarding for video seeking
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_REDIRECTS = 3;

/**
 * Checks if an IPv4 address is in a private, loopback, or reserved range.
 */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a >= 224) return true; // Multicast & Reserved
  return false;
}

/**
 * Checks if a hostname or IP is forbidden / internal.
 */
function isForbiddenHost(host) {
  const clean = host.toLowerCase().trim().replace(/\.$/, '');

  // Forbidden host names
  const forbiddenNames = [
    'localhost',
    'metadata.google.internal',
    'instance-data',
    'metadata',
  ];
  if (forbiddenNames.includes(clean)) return true;

  if (
    clean.endsWith('.localhost') ||
    clean.endsWith('.local') ||
    clean.endsWith('.internal') ||
    clean.endsWith('.lan') ||
    clean.endsWith('.home') ||
    clean.endsWith('.corp') ||
    clean.endsWith('.test') ||
    clean.endsWith('.example') ||
    clean.endsWith('.invalid')
  ) {
    return true;
  }

  // IPv4 check
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) {
    return isPrivateIPv4(clean);
  }

  // IPv6 check
  if (clean.includes(':')) {
    if (clean === '::1' || clean === '::' || clean.startsWith('fc') || clean.startsWith('fd') || clean.startsWith('fe80')) {
      return true;
    }
  }

  return false;
}

/**
 * Validates a target URL before proxying.
 */
function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 2048) {
    return { ok: false, error: 'Invalid or excessively long URL' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Malformed URL' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only HTTP and HTTPS protocols are allowed' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Credentials in URL are forbidden' };
  }

  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) {
    return { ok: false, error: 'Only standard ports 80 and 443 are supported' };
  }

  if (isForbiddenHost(parsed.hostname)) {
    return { ok: false, error: 'Target hostname is forbidden' };
  }

  return { ok: true, url: parsed };
}

const ALLOWED_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'video/mp2t',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mp4',
  'audio/aac',
  'audio/mpeg',
  'text/vtt',
  'text/plain',
  'application/x-subrip',
  'application/octet-stream',
  'image/jpeg',
  'image/png',
  'image/webp',
];

export default {
  async fetch(request) {
    // ── CORS Preflight ────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json(
        { error: 'Method not allowed' },
        { status: 405, headers: CORS_HEADERS }
      );
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');
    const referer = searchParams.get('referer');

    if (!target) {
      return Response.json(
        { error: 'Missing required "url" parameter' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    const targetCheck = validateUrl(target);
    if (!targetCheck.ok) {
      return Response.json(
        { error: targetCheck.error },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // ── Build upstream headers ────────────────────────────────────────────────
    const upstreamHeaders = {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    if (referer) {
      const refCheck = validateUrl(referer);
      if (refCheck.ok) {
        upstreamHeaders['Referer'] = refCheck.url.toString();
        upstreamHeaders['Origin'] = refCheck.url.origin;
      }
    }

    // Forward Range header for video seeking support
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader;
    }

    // ── Fetch upstream with safe redirect following ───────────────────────────
    let currentUrl = targetCheck.url.toString();
    let upstreamRes = null;
    let redirectCount = 0;

    try {
      while (redirectCount <= MAX_REDIRECTS) {
        const res = await fetch(currentUrl, {
          headers: upstreamHeaders,
          redirect: 'manual',
        });

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            return Response.json(
              { error: 'Too many redirects' },
              { status: 502, headers: CORS_HEADERS }
            );
          }

          const loc = res.headers.get('location');
          if (!loc) {
            return Response.json(
              { error: 'Redirect received without Location header' },
              { status: 502, headers: CORS_HEADERS }
            );
          }

          let nextUrl;
          try {
            nextUrl = new URL(loc, currentUrl).toString();
          } catch {
            return Response.json(
              { error: 'Malformed redirect Location header' },
              { status: 502, headers: CORS_HEADERS }
            );
          }

          const nextCheck = validateUrl(nextUrl);
          if (!nextCheck.ok) {
            return Response.json(
              { error: `Redirect to unsafe destination: ${nextCheck.error}` },
              { status: 403, headers: CORS_HEADERS }
            );
          }

          currentUrl = nextCheck.url.toString();
          continue;
        }

        upstreamRes = res;
        break;
      }
    } catch (err) {
      return Response.json(
        { error: 'Failed to reach upstream', detail: String(err) },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    if (!upstreamRes) {
      return Response.json(
        { error: 'No response from upstream server' },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    if (!upstreamRes.ok && upstreamRes.status >= 400) {
      return Response.json(
        { error: `Upstream returned HTTP ${upstreamRes.status}`, url: target },
        { status: upstreamRes.status, headers: CORS_HEADERS }
      );
    }

    const rawContentType = upstreamRes.headers.get('content-type') || '';
    const contentType = rawContentType.toLowerCase().split(';')[0].trim();
    const isManifest = currentUrl.includes('.m3u8') || contentType.includes('mpegurl');
    const isSubtitle = /\.(vtt|srt|ass)$/i.test(currentUrl) || contentType.includes('vtt');

    // ── Content Type Safety ───────────────────────────────────────────────────
    const isMedia =
      isManifest ||
      isSubtitle ||
      ALLOWED_CONTENT_TYPES.includes(contentType) ||
      /\.(ts|mp4|m4s|m4a|aac|mp3|jpg|jpeg|png|webp)($|\?)/i.test(currentUrl);

    if (!isMedia) {
      return Response.json(
        { error: `Refused to proxy non-media content type: "${contentType || 'unknown'}"` },
        { status: 415, headers: CORS_HEADERS }
      );
    }

    // ── Subtitle → proxy as-is ────────────────────────────────────────────────
    if (isSubtitle) {
      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        headers: {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
          ...CORS_HEADERS,
        },
      });
    }

    // ── Manifest → rewrite ALL URLs to pass through this worker ──────────────
    if (isManifest) {
      const workerBase = new URL(request.url).origin;
      const text = await upstreamRes.text();

      if (text.length > MAX_MANIFEST_BYTES) {
        return Response.json(
          { error: 'Manifest exceeds maximum permitted size' },
          { status: 413, headers: CORS_HEADERS }
        );
      }

      const rewritten = text
        .split('\n')
        .map((line) => {
          if (line.includes('URI=')) {
            line = line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
              try {
                const abs = uri.startsWith('http') ? uri : new URL(uri, currentUrl).toString();
                let proxied = `${workerBase}/?url=${encodeURIComponent(abs)}`;
                if (referer) proxied += `&referer=${encodeURIComponent(referer)}`;
                return `URI="${proxied}"`;
              } catch {
                return match;
              }
            });
          }

          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;

          try {
            const resolved = trimmed.startsWith('http') ? trimmed : new URL(trimmed, currentUrl).toString();
            let proxied = `${workerBase}/?url=${encodeURIComponent(resolved)}`;
            if (referer) proxied += `&referer=${encodeURIComponent(referer)}`;
            return proxied;
          } catch {
            return line;
          }
        })
        .join('\n');

      return new Response(rewritten, {
        status: upstreamRes.status,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          ...CORS_HEADERS,
        },
      });
    }

    // ── Video / audio segment streaming ───────────────────────────────────────
    const resHeaders = {
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS,
    };

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) resHeaders['Content-Range'] = contentRange;

    const acceptRanges = upstreamRes.headers.get('accept-ranges');
    resHeaders['Accept-Ranges'] = acceptRanges || 'bytes';

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) resHeaders['Content-Length'] = contentLength;

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  },
};
