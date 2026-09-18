import { NextResponse } from 'next/server';
import { scrapeListingPage } from '@/lib/scrapers/search.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { isValidSlug, parseBoundedInt } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * GET /api/genre/[genre]?page=<n>
 *
 * Returns anime for a specific genre slug.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ genre: string }> }
) {
  try {
    const { genre } = await params;
    if (!genre || !isValidSlug(genre)) {
      return NextResponse.json(
        { ok: false, message: 'Invalid or missing genre parameter' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const rawPage = searchParams.get('page');
    const page = parseBoundedInt(rawPage, 1, 1000, 1) ?? 1;
    const refresh = searchParams.get('refresh') === '1';

    const cleanGenre = genre.toLowerCase();
    const key = `genre:${cleanGenre}:${page}`;
    const path = `/genre/${encodeURIComponent(cleanGenre)}`;

    const data = refresh
      ? await scrapeListingPage(path, page)
      : await getOrSet(key, () => scrapeListingPage(path, page), CACHE_TTL.FILTER);

    return NextResponse.json({ ok: true, data: { ...data, genre: cleanGenre } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[GET /api/genre/[genre]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
