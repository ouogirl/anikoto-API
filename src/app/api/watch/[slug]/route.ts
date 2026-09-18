import {
  scrapeWatchStream,
  scrapeWatch,
  refreshSourceTokens,
  WatchData,
} from '@/lib/scrapers/watch.scraper';
import { cacheGet, cacheSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';
import { isValidSlug, isValidEpisodeNum } from '@/lib/security';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/[slug]?ep=1
 *
 * Retrieves video servers and stream sources for a specific episode.
 *
 * Behaviour:
 * - Cache warm  → instant JSON response  { ok: true, data, streaming: false }
 * - Cache cold  → SSE streaming response (text/event-stream)
 *
 * Query params:
 *   ?refresh=1    Bypass cache and force a fresh stream
 *   ?stream=false Disable streaming and return full JSON response
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { searchParams } = new URL(req.url);
    const resolvedParams = await params;
    const slug = resolvedParams.slug;
    const epNum = searchParams.get('ep') || '1';
    const refresh = searchParams.get('refresh') === '1';
    const isStream = searchParams.get('stream') !== 'false';

    if (!slug || !isValidSlug(slug)) {
      return Response.json(
        { ok: false, message: 'Invalid or missing slug parameter' },
        { status: 400 }
      );
    }

    if (!isValidEpisodeNum(epNum)) {
      return Response.json(
        { ok: false, message: 'Invalid episode parameter' },
        { status: 400 }
      );
    }

    const cacheKey = `watch:${slug}:${epNum}`;

    // ── Cache hit: respond instantly with plain JSON ──────────────────────────
    if (!refresh) {
      const cached = cacheGet<WatchData>(cacheKey);
      if (cached !== undefined) {
        refreshSourceTokens(cached);
        return Response.json({ ok: true, data: cached, streaming: false });
      }
    }

    // ── Non-streaming response: wait for all chunks and return JSON ──────────
    if (!isStream) {
      try {
        const data = await scrapeWatch(slug, epNum);
        cacheSet(cacheKey, data, CACHE_TTL.EPISODE);
        refreshSourceTokens(data);
        return Response.json({ ok: true, data: data, streaming: false });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        const isNotFound = message.toLowerCase().includes('not found');
        return Response.json(
          { ok: false, message },
          { status: isNotFound ? 404 : 500 }
        );
      }
    }

    // ── Cache miss (or forced refresh): stream the response as SSE ────────────
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const collectedSources: WatchData['sources'] = [];
        let episode: WatchData['episode'] | undefined;
        let servers: WatchData['servers'] = [];
        let closed = false;

        const send = (payload: unknown): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            return true;
          } catch {
            closed = true;
            return false;
          }
        };

        const closeStream = () => {
          closed = true;
          try {
            controller.close();
          } catch {
            /* runtime already closed it */
          }
        };

        const generator = scrapeWatchStream(slug, epNum)[Symbol.asyncIterator]();

        // Upstream work stops the moment client hangs up
        const stop = () => {
          closed = true;
          void generator.return?.(undefined).catch(() => undefined);
        };
        req.signal?.addEventListener?.('abort', stop);

        try {
          while (!closed) {
            const { value: chunk, done } = await generator.next();
            if (done) break;
            if (!send(chunk)) break;

            if (chunk.type === 'episode') {
              episode = chunk.episode;
            } else if (chunk.type === 'servers') {
              servers = chunk.servers;
            } else if (chunk.type === 'source') {
              collectedSources.push(chunk.source);
            } else if (chunk.type === 'done') {
              if (episode) {
                const fullData: WatchData = { episode, servers, sources: collectedSources };
                cacheSet(cacheKey, fullData, CACHE_TTL.EPISODE);
              }
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          console.error(`[GET /api/watch stream]`, message);
          send({ type: 'error', ok: false, message });
        } finally {
          req.signal?.removeEventListener?.('abort', stop);
          try {
            await generator.return?.(undefined);
          } catch {
            /* generator already finished */
          }
          closeStream();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const isNotFound = message.toLowerCase().includes('not found');
    console.error(`[GET /api/watch]`, message);
    return Response.json({ ok: false, message }, { status: isNotFound ? 404 : 500 });
  }
}
