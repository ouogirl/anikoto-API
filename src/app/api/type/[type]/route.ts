import { NextResponse } from 'next/server';
import { scrapeListingPage } from '@/lib/scrapers/search.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { parseBoundedInt } from '@/lib/security';

export const dynamic = 'force-dynamic';

const VALID_TYPES = ['tv', 'movie', 'ova', 'ona', 'special', 'music'];

/**
 * GET /api/type/[type]?page=<n>
 *
 * Returns anime by media type.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ type: string }> }
) {
  try {
    const { type } = await params;
    const cleanType = type?.toLowerCase().trim();

    if (!cleanType || !VALID_TYPES.includes(cleanType)) {
      return NextResponse.json(
        { ok: false, message: `type must be one of: ${VALID_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const rawPage = searchParams.get('page');
    const page = parseBoundedInt(rawPage, 1, 1000, 1) ?? 1;
    const refresh = searchParams.get('refresh') === '1';

    const key = `type:${cleanType}:${page}`;
    const path = `/type/${cleanType}`;

    const data = refresh
      ? await scrapeListingPage(path, page)
      : await getOrSet(key, () => scrapeListingPage(path, page), CACHE_TTL.FILTER);

    return NextResponse.json({ ok: true, data: { ...data, mediaType: cleanType } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/type/[type]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
