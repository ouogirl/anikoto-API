import { NextResponse } from 'next/server';
import { scrapeAnimeDetail, scrapeAnimeEpisodes } from '@/lib/scrapers/anime.scraper';
import { fetchPage } from '@/lib/fetcher';
import { getOrSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { isValidSlug, parseBoundedInt } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * Fetch anime detail and episodes using a single page fetch to eliminate
 * redundant network roundtrips.
 */
async function fetchAndCombine(slug: string, startEpisode?: number, endEpisode?: number) {
  const $ = await fetchPage(`/watch/${slug}`);
  const episodes = await scrapeAnimeEpisodes(slug, startEpisode, endEpisode, $);
  const detail = await scrapeAnimeDetail(slug, episodes, $);
  const episodesWithoutRelated = { ...episodes };
  delete episodesWithoutRelated.related;
  return { ...detail, episodes: episodesWithoutRelated };
}

/**
 * GET /api/anime/[slug]
 *
 * Returns detail info for an anime: title, synopsis, genres, studios,
 * MAL score, episode count, status, etc.
 *
 * Supports optional episode range filter:
 *   ?start=1&end=12
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

    // Handle optional episode range parameters
    const startRaw = searchParams.get('start');
    const endRaw = searchParams.get('end');

    let startEpisode: number | undefined;
    let endEpisode: number | undefined;

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
    }

    const rangeSuffix = startEpisode !== undefined ? `:ep${startEpisode}-${endEpisode}` : '';
    const key = `anime:${slug}${rangeSuffix}`;

    const data = refresh
      ? await fetchAndCombine(slug, startEpisode, endEpisode)
      : await getOrSet(key, () => fetchAndCombine(slug, startEpisode, endEpisode), CACHE_TTL.ANIME);

    return NextResponse.json({ ok: true, data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    if (message.toLowerCase().includes('not found')) {
      return NextResponse.json({ ok: false, message: 'Anime not found' }, { status: 404 });
    }
    console.error('[GET /api/anime/[slug]]', message);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
