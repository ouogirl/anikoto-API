import { NextResponse } from 'next/server';
import { scrapeFilter } from '@/lib/scrapers/search.scraper';
import { FilterParams } from '@/lib/types';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL, FILTER_OPTIONS } from '@/lib/constants';
import { parseBoundedInt } from '@/lib/security';
import { searchLimiter, getClientIp } from '@/lib/rate-limiter';

export const dynamic = 'force-dynamic';

/**
 * Normalizes an array of query parameters by filtering out empty items,
 * removing duplicates, and sorting them for a deterministic canonical representation.
 */
function normalizeParamArray(items: string[]): string[] {
  return Array.from(new Set(items.map((i) => i.trim()).filter(Boolean))).sort();
}

/**
 * GET /api/filter
 *
 * Advanced filter for anime with multiple parameters.
 */
export async function GET(req: Request) {
  try {
    const clientIp = getClientIp(req);
    const limit = searchLimiter.check(clientIp);
    if (!limit.allowed) {
      return NextResponse.json(
        { ok: false, message: 'Too many filter requests. Please slow down.' },
        {
          status: 429,
          headers: { 'Retry-After': String(limit.resetAfter) },
        }
      );
    }

    const { searchParams } = new URL(req.url);

    const rawKeyword = searchParams.get('keyword');
    const keyword = rawKeyword ? rawKeyword.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) : undefined;

    const rawPage = searchParams.get('page');
    const pageNum = parseBoundedInt(rawPage, 1, 1000, 1) ?? 1;

    const genre = normalizeParamArray(searchParams.getAll('genre[]'));
    const season = normalizeParamArray(searchParams.getAll('season[]'));
    const year = normalizeParamArray(searchParams.getAll('year[]'));
    const type = normalizeParamArray([
      ...searchParams.getAll('type[]'),
      ...searchParams.getAll('term_type[]'),
    ]);
    const status = normalizeParamArray(searchParams.getAll('status[]'));
    const language = normalizeParamArray(searchParams.getAll('language[]'));
    const rating = normalizeParamArray(searchParams.getAll('rating[]'));
    const sort = searchParams.get('sort')?.trim() || undefined;

    const params: FilterParams = {
      keyword: keyword || undefined,
      genre: genre.length > 0 ? genre : undefined,
      season: season.length > 0 ? season : undefined,
      year: year.length > 0 ? year : undefined,
      type: type.length > 0 ? type : undefined,
      status: status.length > 0 ? status : undefined,
      language: language.length > 0 ? language : undefined,
      rating: rating.length > 0 ? rating : undefined,
      sort,
      page: String(pageNum),
    };

    // Canonical sorted JSON for cache key
    const canonicalKey = JSON.stringify(params, Object.keys(params).sort());
    const cacheKey = `filter:${canonicalKey}`;
    const refresh = searchParams.get('refresh') === '1';

    const data = refresh
      ? await scrapeFilter(params)
      : await getOrSet(cacheKey, () => scrapeFilter(params), CACHE_TTL.FILTER);

    data.options = FILTER_OPTIONS;

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/filter]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
