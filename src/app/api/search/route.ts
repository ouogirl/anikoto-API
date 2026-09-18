import { NextResponse } from 'next/server';
import { scrapeSearch } from '@/lib/scrapers/search.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { searchLimiter, getClientIp } from '@/lib/rate-limiter';

export const dynamic = 'force-dynamic';

/**
 * GET /api/search?keyword=<query>
 *
 * Search anime by keyword.
 */
export async function GET(req: Request) {
  try {
    // Abuse mitigation
    const clientIp = getClientIp(req);
    const limit = searchLimiter.check(clientIp);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, message: 'Too many search requests. Please slow down.' },
        {
          status: 429,
          headers: { 'Retry-After': String(limit.resetAfter) },
        }
      );
    }

    const { searchParams } = new URL(req.url);
    const rawKeyword = searchParams.get('keyword');
    const refresh = searchParams.get('refresh') === '1';

    if (!rawKeyword || !rawKeyword.trim()) {
      return NextResponse.json(
        { ok: false, message: 'keyword query parameter is required' },
        { status: 400 }
      );
    }

    const cleanKeyword = rawKeyword.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200);
    if (!cleanKeyword) {
      return NextResponse.json(
        { ok: false, message: 'keyword query parameter cannot be empty' },
        { status: 400 }
      );
    }

    const key = `search:${cleanKeyword.toLowerCase()}`;
    const data = refresh
      ? await scrapeSearch(cleanKeyword)
      : await getOrSet(key, () => scrapeSearch(cleanKeyword), CACHE_TTL.SEARCH);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/search]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
