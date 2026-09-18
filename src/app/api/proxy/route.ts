import { NextResponse } from 'next/server';
import axios, { AxiosResponse } from 'axios';
import { Readable } from 'stream';
import { DEFAULT_HEADERS } from '@/lib/constants';
import {
  validateSafeUrl,
  isAllowedContentType,
  sanitizeFilename,
} from '@/lib/security';
import { proxyLimiter, getClientIp } from '@/lib/rate-limiter';

export const dynamic = 'force-dynamic';

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024; // 2MB max for m3u8 playlists
const MAX_REDIRECTS = 3;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
};

/**
 * OPTIONS handler for CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * GET /api/proxy?url=<encoded-url>&referer=<encoded-referer>
 *
 * Secure streaming proxy for HLS playlists (.m3u8), video segments (.ts/.mp4),
 * and subtitle files (.vtt/.srt).
 *
 * Security features:
 * - SSRF protection (private IP filtering, DNS rebinding mitigation)
 * - Safe redirect traversal (validates every redirect hop)
 * - Media-only content type enforcement (rejects HTML, executables, scripts)
 * - Memory protection: streams media segments directly without RAM buffering
 * - Abuse mitigation via in-memory rate limiting
 * - Full video seeking support (Range / Content-Range / 206 Partial Content)
 */
export async function GET(req: Request) {
  // ── 1. Rate limiting check ────────────────────────────────────────────────
  const clientIp = getClientIp(req);
  const limit = proxyLimiter.check(clientIp);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, message: 'Too many requests. Please slow down.' },
      {
        status: 429,
        headers: {
          'Retry-After': String(limit.resetAfter),
          ...CORS_HEADERS,
        },
      }
    );
  }

  // ── 2. Parameter extraction & validation ──────────────────────────────────
  const { searchParams } = new URL(req.url);
  const rawTargetUrl = searchParams.get('url');
  const rawReferer = searchParams.get('referer');

  if (!rawTargetUrl) {
    return NextResponse.json(
      { ok: false, message: 'Missing required "url" parameter' },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Initial SSRF check on target URL
  const validation = await validateSafeUrl(rawTargetUrl);
  if (!validation.safe || !validation.url) {
    return NextResponse.json(
      { ok: false, message: `Blocked unsafe target URL: ${validation.error || 'Invalid URL'}` },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  // Validate and sanitize referer if provided
  let refererHeader: string | undefined;
  let originHeader: string | undefined;

  if (rawReferer) {
    const refValidation = await validateSafeUrl(rawReferer, { skipDnsLookup: true });
    if (refValidation.safe && refValidation.url) {
      refererHeader = refValidation.url.toString();
      originHeader = refValidation.url.origin;
    }
  }

  // ── 3. Build upstream request headers ─────────────────────────────────────
  const upstreamHeaders: Record<string, string> = {
    'User-Agent': DEFAULT_HEADERS['User-Agent'],
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };

  if (refererHeader) {
    upstreamHeaders['Referer'] = refererHeader;
    if (originHeader) {
      upstreamHeaders['Origin'] = originHeader;
    }
  }

  // Forward Range header for video seeking support
  const incomingRange = req.headers.get('range');
  if (incomingRange) {
    upstreamHeaders['Range'] = incomingRange;
  }

  // ── 4. Execute request with controlled redirect following ──────────────────
  let currentUrl = validation.url.toString();
  let response: AxiosResponse<Readable> | undefined;
  let redirectCount = 0;

  try {
    while (redirectCount <= MAX_REDIRECTS) {
      const resp: AxiosResponse<Readable> = await axios.get(currentUrl, {
        headers: upstreamHeaders,
        responseType: 'stream',
        timeout: 20_000,
        maxRedirects: 0,
        validateStatus: () => true, // inspect all statuses
      });

      // Handle HTTP redirects securely
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          return NextResponse.json(
            { ok: false, message: 'Too many redirects from upstream' },
            { status: 502, headers: CORS_HEADERS }
          );
        }

        const location = resp.headers['location'];
        if (!location) {
          return NextResponse.json(
            { ok: false, message: 'Redirect received without Location header' },
            { status: 502, headers: CORS_HEADERS }
          );
        }

        let nextUrl: string;
        try {
          nextUrl = new URL(location, currentUrl).toString();
        } catch {
          return NextResponse.json(
            { ok: false, message: 'Malformed redirect Location header' },
            { status: 502, headers: CORS_HEADERS }
          );
        }

        // Validate redirect target against SSRF rules
        const redirectCheck = await validateSafeUrl(nextUrl);
        if (!redirectCheck.safe || !redirectCheck.url) {
          return NextResponse.json(
            { ok: false, message: `Redirect to unsafe destination blocked: ${redirectCheck.error}` },
            { status: 403, headers: CORS_HEADERS }
          );
        }

        currentUrl = redirectCheck.url.toString();
        continue;
      }

      response = resp;
      break;
    }

    if (!response) {
      return NextResponse.json(
        { ok: false, message: 'No response from upstream server' },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    // Upstream errors (401/403/404/500 etc.)
    if (response.status >= 400) {
      return NextResponse.json(
        {
          ok: false,
          message: `Upstream error: HTTP ${response.status}`,
          upstreamStatus: response.status,
        },
        { status: response.status, headers: CORS_HEADERS }
      );
    }

    const rawContentType = (response.headers['content-type'] as string) || '';
    const contentType = rawContentType.toLowerCase().split(';')[0].trim();
    const isManifest = currentUrl.includes('.m3u8') || contentType.includes('mpegurl');

    // ── 5. Media safety check ────────────────────────────────────────────────
    // Ensure we do not proxy HTML, scripts, executables, or unknown documents
    const isRecognizedMedia =
      isManifest ||
      isAllowedContentType(contentType) ||
      /\.(m3u8|ts|mp4|m4s|m4a|aac|mp3|vtt|srt|ass|jpg|jpeg|png|webp)($|\?)/i.test(currentUrl);

    if (!isRecognizedMedia) {
      return NextResponse.json(
        {
          ok: false,
          message: `Refused to proxy non-media content type "${contentType || 'unknown'}"`,
        },
        { status: 415, headers: CORS_HEADERS }
      );
    }

    // ── 6. Handle HLS Playlists (.m3u8) ──────────────────────────────────────
    if (isManifest) {
      // Buffer playlist text (capped at MAX_MANIFEST_BYTES)
      const stream = response.data;
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buf.length;
        if (totalBytes > MAX_MANIFEST_BYTES) {
          return NextResponse.json(
            { ok: false, message: 'Manifest exceeds maximum permitted size' },
            { status: 413, headers: CORS_HEADERS }
          );
        }
        chunks.push(buf);
      }

      const text = Buffer.concat(chunks).toString('utf-8');
      const baseUrl = new URL(currentUrl);

      // Rewrite internal URLs inside playlist to route through /api/proxy
      const rewritten = text
        .split('\n')
        .map((line) => {
          // Rewrite URI attributes in tags (#EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA)
          if (line.includes('URI=')) {
            return line.replace(/URI=["']([^"']+)["']/g, (_match, uri) => {
              try {
                const abs = uri.startsWith('http') ? uri : new URL(uri, baseUrl).toString();
                let proxied = `/api/proxy?url=${encodeURIComponent(abs)}`;
                if (rawReferer) proxied += `&referer=${encodeURIComponent(rawReferer)}`;
                return `URI="${proxied}"`;
              } catch {
                return _match;
              }
            });
          }

          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) return line;

          // Rewrite media segment or sub-playlist URL line
          try {
            const abs = trimmed.startsWith('http') ? trimmed : new URL(trimmed, baseUrl).toString();
            let proxied = `/api/proxy?url=${encodeURIComponent(abs)}`;
            if (rawReferer) proxied += `&referer=${encodeURIComponent(rawReferer)}`;
            return proxied;
          } catch {
            return line;
          }
        })
        .join('\n');

      return new NextResponse(rewritten, {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          ...CORS_HEADERS,
        },
      });
    }

    // ── 7. Handle Media Segments and Subtitles (Streaming Passthrough) ────────
    // DO NOT buffer large media in RAM. Convert the Node readable stream to a Web ReadableStream.
    const webStream = Readable.toWeb(response.data) as ReadableStream<Uint8Array>;

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', contentType || 'application/octet-stream');
    resHeaders.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');

    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      resHeaders.set(k, v);
    }

    // Forward range and seeking headers
    const contentRange = response.headers['content-range'] as string | undefined;
    if (contentRange) {
      resHeaders.set('Content-Range', contentRange);
    }

    const acceptRanges = response.headers['accept-ranges'] as string | undefined;
    if (acceptRanges) {
      resHeaders.set('Accept-Ranges', acceptRanges);
    } else {
      resHeaders.set('Accept-Ranges', 'bytes');
    }

    const contentLength = response.headers['content-length'] as string | undefined;
    if (contentLength) {
      resHeaders.set('Content-Length', contentLength);
    }

    // Content-Disposition safety: never pass arbitrary executable filenames
    const rawDisp = response.headers['content-disposition'] as string | undefined;
    if (rawDisp) {
      const match = rawDisp.match(/filename=["']?([^"';]+)["']?/i);
      if (match) {
        const safeName = sanitizeFilename(match[1]);
        resHeaders.set('Content-Disposition', `inline; filename="${safeName}"`);
      }
    }

    return new NextResponse(webStream, {
      status: response.status === 206 ? 206 : 200,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 502;
      return NextResponse.json(
        { ok: false, message: `Proxy upstream error: ${err.message}`, code: err.code },
        { status, headers: CORS_HEADERS }
      );
    }

    const message = err instanceof Error ? err.message : 'Internal proxy error';
    return NextResponse.json(
      { ok: false, message: `Proxy failed: ${message}` },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
