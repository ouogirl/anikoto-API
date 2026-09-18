import {
  scrapeWatchStream,
  scrapeWatch,
  refreshSourceTokens,
  WatchData,
} from '@/lib/scrapers/watch.scraper';
import { cacheGet, cacheSet } from '@/lib/cache';
import { CACHE_TTL } from '@/lib/constants';

export const dynamic = 'force-dynamic';

/**
 * GET /api/watch/[slug]?ep=1
 *
 * Retrieves video servers and stream sources for a specific episode.
 *
 * Behaviour:
 * - Cache warm  → instant JSON response  { ok: true, data, streaming: false }
 * - Cache cold  → SSE streaming response (text/event-stream); chunks arrive progressively:
 *     1. data: { "type": "episode", "episode": {...} }          — after ~1 upstream RTT
 *     2. data: { "type": "servers", "servers": [...] }          — after ~2 upstream RTTs
 *     3. data: { "type": "source",  "source": {...} }  (×N)    — as each server resolves
 *     4. data: { "type": "done" }                               — stream closed; result cached
 *
 * Add ?refresh=1 to bypass cache and force a fresh stream.
 * Add ?stream=false to disable streaming and return full JSON response.
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

    if (!slug) {
      return Response.json({ ok: false, message: 'Missing slug' }, { status: 400 });
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
      const data = await scrapeWatch(slug, epNum);
      cacheSet(cacheKey, data, CACHE_TTL.EPISODE);
      refreshSourceTokens(data);
      return Response.json({ ok: true, data, streaming: false });
    }

    // ── Cache miss (or forced refresh): stream the response as SSE ────────────
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const collectedSources: WatchData['sources'] = [];
        let episode: WatchData['episode'] | undefined;
        let servers: WatchData['servers'] = [];

        // The client can disappear at any moment (tab closed, fetch aborted,
        // StreamVault "cancel" button). Writing to a closed controller throws
        // "Invalid state: Controller is already closed", so track the state
        // ourselves and stop pulling from the generator as soon as that happens.
        let closed = false;

        const send = (payload: unknown): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            return true;
          } catch {
            // Reader went away between our check and the write.
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

        // Upstream work should stop the moment the client hangs up.
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

            // Accumulate data to cache when complete
            if (chunk.type === 'episode') {
              episode = chunk.episode;
            } else if (chunk.type === 'servers') {
              servers = chunk.servers;
            } else if (chunk.type === 'source') {
              collectedSources.push(chunk.source);
            } else if (chunk.type === 'done') {
              // Persist completed result so the next request is an instant cache hit
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
        'X-Accel-Buffering': 'no', // Disable Nginx/proxy buffering
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[GET /api/watch]`, message);
    return Response.json({ ok: false, message }, { status: 500 });
  }
}
