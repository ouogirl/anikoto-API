import { NextResponse } from 'next/server';
import { scrapeListingPage } from '@/lib/scrapers/search.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { parseBoundedInt } from '@/lib/security';

export const dynamic = 'force-dynamic';

type StatusType = 'currently-airing' | 'finished-airing' | 'not-yet-aired';

const STATUS_PATHS: Record<StatusType, string> = {
  'currently-airing': '/status/currently-airing',
  'finished-airing': '/status/finished-airing',
  'not-yet-aired': '/status/not-yet-aired',
};

/**
 * GET /api/status?type=<type>&page=<n>
 *
 * Returns anime by airing status.
 */
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const rawType = (searchParams.get('type') ?? 'currently-airing').toLowerCase().trim() as StatusType;

    if (!STATUS_PATHS[rawType]) {
      return NextResponse.json(
        { ok: false, message: `type must be one of: ${Object.keys(STATUS_PATHS).join(', ')}` },
        { status: 400 }
      );
    }

    const rawPage = searchParams.get('page');
    const page = parseBoundedInt(rawPage, 1, 1000, 1) ?? 1;
    const refresh = searchParams.get('refresh') === '1';

    const key = `status:${rawType}:${page}`;
    const path = STATUS_PATHS[rawType];

    const data = refresh
      ? await scrapeListingPage(path, page)
      : await getOrSet(key, () => scrapeListingPage(path, page), CACHE_TTL.FILTER);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/status]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
