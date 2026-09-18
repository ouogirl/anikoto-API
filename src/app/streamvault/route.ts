export const dynamic = 'force-dynamic';

/**
 * Convenience alias: `/streamvault` → `/streamvault.html`.
 *
 * The client lives in `public/streamvault.html`, so `/streamvault` (no
 * extension) used to 404 — including for saved bookmarks. A relative Location
 * header keeps this working regardless of the host/proxy that served it.
 */
export function GET() {
  return new Response(null, {
    status: 308,
    headers: { Location: '/streamvault.html' },
  });
}
