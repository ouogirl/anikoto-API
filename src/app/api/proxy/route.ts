import { NextResponse } from 'next/server';
import axios from 'axios';
import { DEFAULT_HEADERS } from '@/lib/constants';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get('url');
  const referer = searchParams.get('referer');

  if (!targetUrl) {
    return NextResponse.json({ ok: false, message: 'Missing url parameter' }, { status: 400 });
  }

  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_HEADERS['User-Agent'],
    'Accept': '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'cross-site',
  };

  if (referer) {
    headers['Referer'] = referer;
    try {
      headers['Origin'] = new URL(referer).origin;
    } catch (_) {
      // ignore malformed referer
    }
  }

  // Forward Range header if present (needed for partial content / video seeking)
  const rangeHeader = req.headers.get('range');
  if (rangeHeader) {
    headers['Range'] = rangeHeader;
  }

  try {
    const response = await axios.get(targetUrl, {
      responseType: 'arraybuffer',
      headers,
      timeout: 20_000,
      // Don't throw on non-2xx so we can forward the real status
      validateStatus: (status) => status < 600,
    });

    // If upstream blocked us (403/401/451), return the real status with a helpful message
    if (response.status === 403 || response.status === 401) {
      console.error(`[Proxy] Upstream blocked: ${response.status} on ${targetUrl}`);
      return NextResponse.json(
        {
          ok: false,
          message: `Upstream server blocked the request (HTTP ${response.status}). Try using the Cloudflare Worker proxy instead.`,
          upstreamStatus: response.status,
          url: targetUrl,
        },
        { status: response.status }
      );
    }

    if (response.status >= 400) {
      console.error(`[Proxy] Upstream error: ${response.status} on ${targetUrl}`);
      return NextResponse.json(
        { ok: false, message: `Upstream error: HTTP ${response.status}`, upstreamStatus: response.status, url: targetUrl },
        { status: response.status }
      );
    }

    const resHeaders = new Headers();
    const contentType = (response.headers['content-type'] as string) || 'application/octet-stream';
    resHeaders.set('Content-Type', contentType);
    resHeaders.set('Access-Control-Allow-Origin', '*');
    resHeaders.set('Cache-Control', 'no-cache');

    // Forward Accept-Ranges and Content-Range for video seeking support
    if (response.headers['accept-ranges']) {
      resHeaders.set('Accept-Ranges', response.headers['accept-ranges'] as string);
    }
    if (response.headers['content-range']) {
      resHeaders.set('Content-Range', response.headers['content-range'] as string);
    }

    let responseData = response.data;

    // Rewrite internal URLs inside m3u8 playlists to pass through this proxy
    if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
      const text = Buffer.from(responseData).toString('utf-8');
      const baseUrl = new URL(targetUrl);

      const rewrittenText = text.split('\n').map(line => {
        // Rewrite URI attributes in tags (e.g. #EXT-X-KEY:URI="...", #EXT-X-MAP:URI="...", #EXT-X-MEDIA:URI="...")
        if (line.includes('URI=')) {
          line = line.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
            let keyUrl = uri;
            if (!keyUrl.startsWith('http')) {
              keyUrl = new URL(keyUrl, baseUrl).toString();
            }
            const proxied = `/api/proxy?url=${encodeURIComponent(keyUrl)}&referer=${encodeURIComponent(referer || '')}`;
            return `URI="${proxied}"`;
          });
        }

        if (line.startsWith('#') || !line.trim()) return line;

        // This is a media segment or sub-playlist line
        let segmentUrl = line.trim();
        if (!segmentUrl.startsWith('http')) {
          segmentUrl = new URL(segmentUrl, baseUrl).toString();
        }

        // Return the proxied URL
        return `/api/proxy?url=${encodeURIComponent(segmentUrl)}&referer=${encodeURIComponent(referer || '')}`;
      }).join('\n');

      responseData = Buffer.from(rewrittenText, 'utf-8');
    }

    return new NextResponse(responseData, {
      status: response.status === 206 ? 206 : 200,
      headers: resHeaders,
    });
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status || 500;
      const code = err.code || '';
      console.error(`[Proxy Error] ${status} (${code}) on ${targetUrl}`);
      return NextResponse.json(
        { ok: false, message: `Proxy failed: ${err.message}`, code, url: targetUrl },
        { status }
      );
    }
    console.error(`[Proxy Error] Unknown error on ${targetUrl}:`, err);
    return NextResponse.json({ ok: false, message: 'Proxy request failed' }, { status: 500 });
  }
}
