import { NextResponse } from 'next/server';
import { scrapeAnimeEpisodes } from '@/lib/scrapers/anime.scraper';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { isValidSlug, parseBoundedInt } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * GET /api/anime/[slug]/episodes
 *
 * Returns the full episode list for an anime, optionally filtered by episode range.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    if (!slug || !isValidSlug(slug)) {
      return NextResponse.json(
        { ok: false, message: 'Invalid or missing slug parameter' },
        { status: 400 }
      );
    }

    const { searchParams } = new URL(req.url);
    const refresh = searchParams.get('refresh') === '1';

    // Handle episode range parameters
    const startRaw = searchParams.get('start');
    const endRaw = searchParams.get('end');

    let startEpisode: number | undefined;
    let endEpisode: number | undefined;
    let cacheKey = `anime:episodes:${slug}`;

    if (startRaw !== null || endRaw !== null) {
      if (startRaw === null || endRaw === null) {
        return NextResponse.json(
          { ok: false, message: 'Both start and end are required when filtering by episode range.' },
          { status: 400 }
        );
      }

      const s = parseBoundedInt(startRaw, 1, 10000);
      const e = parseBoundedInt(endRaw, 1, 10000);

      if (s === null || e === null || s > e) {
        return NextResponse.json(
          { ok: false, message: 'Invalid episode range. start and end must be integers between 1 and 10000 with start <= end.' },
          { status: 400 }
        );
      }

      startEpisode = s;
      endEpisode = e;
      cacheKey += `:${s}-${e}`;
    }

    const data = refresh
      ? await scrapeAnimeEpisodes(slug, startEpisode, endEpisode)
      : await getOrSet(cacheKey, () => scrapeAnimeEpisodes(slug, startEpisode, endEpisode), CACHE_TTL.EPISODE);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.toLowerCase().includes('not found')) {
      return NextResponse.json({ ok: false, message: 'Anime not found' }, { status: 404 });
    }
    console.error('[GET /api/anime/[slug]/episodes]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
