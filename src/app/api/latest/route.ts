import { NextResponse } from 'next/server';
import { scrapeListingPage } from '@/lib/scrapers/search.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { parseBoundedInt } from '@/lib/security';

export const dynamic = 'force-dynamic';

type Listing = 'latest-updated' | 'new-release' | 'most-viewed';

const LISTING_PATHS: Record<Listing, string> = {
  'latest-updated': '/latest-updated',
  'new-release': '/new-release',
  'most-viewed': '/most-viewed',
};

/**
 * GET /api/latest?type=<type>&page=<n>
 *
 * Returns paginated anime listing pages.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const rawType = searchParams.get('type') ?? 'latest-updated';
    const type = rawType as Listing;

    if (!LISTING_PATHS[type]) {
      return NextResponse.json(
        { ok: false, message: `type must be one of: ${Object.keys(LISTING_PATHS).join(', ')}` },
        { status: 400 }
      );
    }

    const rawPage = searchParams.get('page');
    const page = parseBoundedInt(rawPage, 1, 1000, 1) ?? 1;
    const refresh = searchParams.get('refresh') === '1';

    const key = `listing:${type}:${page}`;
    const path = LISTING_PATHS[type];

    const data = refresh
      ? await scrapeListingPage(path, page)
      : await getOrSet(key, () => scrapeListingPage(path, page), CACHE_TTL.HOME);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/latest]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
