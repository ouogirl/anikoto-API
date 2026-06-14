/* eslint-disable */
/**
 * Anikoto Proxy — Cloudflare Worker
 *
 * Proxies ALL HLS requests (manifests, segments, subtitles) with Referer spoofing.
 * CF Workers free tier: 100K req/day, UNLIMITED bandwidth — safe for video proxying.
 *
 * Routes:
 *  GET /?url=<encoded>&referer=<encoded>   — proxy the target URL
 *  OPTIONS                                  — CORS preflight
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

export default {
  async fetch(request) {
    // ── CORS Preflight ────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const { searchParams } = new URL(request.url);
    const target = searchParams.get('url');
    const referer = searchParams.get('referer');

    if (!target) {
      return Response.json({ error: 'Missing url parameter' }, { status: 400, headers: CORS_HEADERS });
    }

    // ── Build upstream headers ────────────────────────────────────────────────
    const upstreamHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
    };

    if (referer) {
      upstreamHeaders['Referer'] = referer;
      try {
        upstreamHeaders['Origin'] = new URL(referer).origin;
      } catch (_) {}
    }

    // Forward Range header for video seeking support
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader;
    }

    // ── Fetch upstream ────────────────────────────────────────────────────────
    let upstreamRes;
    try {
      upstreamRes = await fetch(target, {
        headers: upstreamHeaders,
        redirect: 'follow',
      });
    } catch (err) {
      return Response.json(
        { error: 'Failed to reach upstream', detail: String(err) },
        { status: 502, headers: CORS_HEADERS }
      );
    }

    if (!upstreamRes.ok) {
      return Response.json(
        { error: `Upstream returned HTTP ${upstreamRes.status}`, url: target },
        { status: upstreamRes.status, headers: CORS_HEADERS }
      );
    }

    const contentType = upstreamRes.headers.get('content-type') || '';
    const isManifest = /\.m3u8/i.test(target) || contentType.includes('mpegurl');
    const isSubtitle = /\.(vtt|srt|ass)$/i.test(target) || contentType.includes('vtt');

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

      const rewritten = text
        .split('\n')
        .map(line => {
          // Rewrite URI="..." in tag attributes (AES key, init segment, subtitles)
          if (line.includes('URI=')) {
            line = line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
              try {
                const abs = uri.startsWith('http') ? uri : new URL(uri, target).toString();
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

          // Segment / sub-playlist lines
          try {
            const resolved = new URL(trimmed, target).toString();
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
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store',
          ...CORS_HEADERS,
        },
      });
    }

    // ── Video / audio segment ─────────────────────────────────────────────────
    // CDNs disguise .ts segments as image/jpg, image/png etc. to prevent hotlinking.
    // Force application/octet-stream so HLS.js decodes them correctly.
    const isRealMedia =
      contentType.includes('video') ||
      contentType.includes('audio') ||
      contentType.includes('octet-stream') ||
      contentType.includes('mp4') ||
      contentType.includes('mpegurl') ||
      contentType.includes('mpeg');

    const resHeaders = {
      'Content-Type': isRealMedia ? contentType : 'application/octet-stream',
      'Cache-Control': 'public, max-age=3600',
      ...CORS_HEADERS,
    };

    // Forward Content-Range for seeking support
    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) resHeaders['Content-Range'] = contentRange;
    const acceptRanges = upstreamRes.headers.get('accept-ranges');
    if (acceptRanges) resHeaders['Accept-Ranges'] = acceptRanges;

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      headers: resHeaders,
    });
  },
};
