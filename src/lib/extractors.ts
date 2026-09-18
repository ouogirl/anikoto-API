import axios from 'axios';
import crypto from 'crypto';
import { DEFAULT_HEADERS } from './constants';
import { validateSafeUrl } from './security';

const KIWI_MAPPER_URLS = [
  'https://mapper.nekostream.site/api/mal',
  'https://mapper.mewcdn.online/api/mal',
];

async function parseM3u8Subtitles(
  m3u8Url: string,
  referer: string
): Promise<{ file: string; label?: string; kind?: string; default?: boolean }[]> {
  try {
    const check = await validateSafeUrl(m3u8Url);
    if (!check.safe) return [];

    const { data } = await axios.get<string>(m3u8Url, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 5000,
    });
    const tracks: { file: string; label?: string; kind?: string; default?: boolean }[] = [];
    for (const line of data.split('\n')) {
      if (!line.startsWith('#EXT-X-MEDIA') || !line.includes('TYPE=SUBTITLES')) continue;
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (!uri) continue;
      const label = line.match(/NAME="([^"]+)"/)?.[1];
      const isDefault = /DEFAULT=YES/i.test(line);
      const fullUri = uri.startsWith('http') ? uri : new URL(uri, m3u8Url).toString();
      tracks.push({ file: fullUri, label: label || 'Unknown', kind: 'subtitles', default: isDefault });
    }
    return tracks;
  } catch {
    return [];
  }
}

export interface SubtitleTrack {
  file: string;
  label?: string;
  kind?: string;
  default?: boolean;
}

export interface ExtractedStream {
  /** Direct HLS URL, or null when only download links could be resolved. */
  m3u8: string | null;
  referer: string;
  tracks: SubtitleTrack[];
  /** Kiwi mapper side-channel: direct download links per quality (mp4). */
  downloads?: Record<string, string>;
}

let _keysCache: Record<string, string> | null = null;
let _keysCacheAt = 0;
const KEYS_CACHE_MS = 15 * 60 * 1000;

async function getMegacloudKeys(): Promise<Record<string, string>> {
  const now = Date.now();
  if (_keysCache && now - _keysCacheAt < KEYS_CACHE_MS) return _keysCache;
  try {
    const { data } = await axios.get<Record<string, string>>(
      'https://raw.githubusercontent.com/yogesh-hacker/MegacloudKeys/refs/heads/main/keys.json',
      { timeout: 5000 }
    );
    _keysCache = data;
    _keysCacheAt = now;
    return data;
  } catch (err) {
    console.error('[getMegacloudKeys] Failed to fetch Megacloud keys:', err instanceof Error ? err.message : err);
    return _keysCache || {};
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MegaPlay (megaplay.buzz · vidwish.live · megacloud.bloggy.click · vidtube.site)
//
// The player page still exposes its stream id either as `data-id="…"` or in the
// <title> ("File 43070 - MegaPlay").
//
// What changed on the site (and why every source used to come back "no-m3u8"):
//   • /stream/getSources no longer returns `sources: { file }`. It now returns
//     either a plaintext `sources` string, or an AES-256-CBC `enc` blob that the
//     player bundle decrypts client-side (AES key/IV below).
//   • Streams that come out of `enc` are path-locked: the CDN requires a short
//     lived `token=` HMAC query param that the player also generates client-side.
//
// Constants below are taken from the current player bundle and can be overridden
// with env vars (MEGAPLAY_AES_KEY / MEGAPLAY_AES_IV / MEGAPLAY_TOKEN_SECRET) if
// the site rotates them without a code change.
// ════════════════════════════════════════════════════════════════════════════

const MEGAPLAY_AES_KEY = process.env.MEGAPLAY_AES_KEY || 'i?LMTAx0Q6,:}50U';
const MEGAPLAY_AES_IV = process.env.MEGAPLAY_AES_IV || "W0;27ToaUpl_P%'c";
const MEGAPLAY_TOKEN_SECRET = process.env.MEGAPLAY_TOKEN_SECRET || 'MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s';
const MEGAPLAY_TOKEN_TTL = Number(process.env.MEGAPLAY_TOKEN_TTL_SECONDS) > 0
  ? Number(process.env.MEGAPLAY_TOKEN_TTL_SECONDS)
  : 90;

/** Token-gated CDN paths look like /<32 hex>/<32 hex>/master.m3u8 */
const MEGAPLAY_PATH_KEY_RE = /\/([a-f0-9]{32})\/([a-f0-9]{32})\//i;
const MEGAPLAY_PAYLOAD_RE = /^(\d{6,})\|([a-f0-9]{32}\/[a-f0-9]{32})$/i;

function aesCbcDecrypt(value: string, keyText: string, ivText: string): string | null {
  try {
    const key = Buffer.alloc(32);
    Buffer.from(keyText, 'utf8').copy(key);
    const iv = Buffer.from(ivText, 'utf8').subarray(0, 16);
    if (iv.length !== 16) return null;
    const encrypted = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!encrypted.length || encrypted.length % 16 !== 0) return null;
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Pull the stream URL out of a decrypted payload (`{"file":"…"}` and friends). */
function pickFileFromText(text: string): string | null {
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    const candidates = [
      json?.file,
      json?.url,
      json?.sources?.file,
      Array.isArray(json?.sources) ? json.sources[0]?.file ?? json.sources[0]?.url : undefined,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
  } catch {
    // not JSON — fall back to a regex scan below
  }
  const m = text.match(/"file"\s*:\s*"([^"]+)"/) || text.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/i);
  return m ? (m[1] ?? m[0]) : null;
}

const megaplayDebug = (...args: unknown[]) => {
  if (process.env.DEBUG_MEGAPLAY === '1') console.error('[megaplay]', ...args);
};

/** Sign a path-locked MegaPlay CDN URL with the player's HMAC `token` param. */
function signMegaplayUrl(url: string, secret = MEGAPLAY_TOKEN_SECRET, ttl = MEGAPLAY_TOKEN_TTL): string | null {
  const match = url.match(MEGAPLAY_PATH_KEY_RE);
  if (!match) return null;
  const pathKey = `${match[1].toLowerCase()}/${match[2].toLowerCase()}`;
  const payload = `${Math.floor(Date.now() / 1000) + ttl}|${pathKey}`;
  try {
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
    const signed = new URL(url);
    signed.searchParams.set('token', `${payloadB64}.${signature}`);
    return signed.toString();
  } catch {
    return null;
  }
}

/**
 * Re-sign a MegaPlay token we minted ourselves when it is about to expire.
 * Watch results are cached for 10 minutes while player tokens live ~90s, so a
 * cached response would otherwise hand out dead URLs.
 *
 * Tokens that don't match our own `<expiry>|<pathKey>` payload shape (i.e. ones
 * the site generated) are returned untouched — we never second-guess upstream.
 */
export function refreshMegaplayToken(url: string | null | undefined): string | null {
  if (!url) return url ?? null;
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    if (!token) return url;
    const payload = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
    const payloadMatch = payload.match(MEGAPLAY_PAYLOAD_RE);
    const pathMatch = parsed.pathname.match(MEGAPLAY_PATH_KEY_RE);
    if (!payloadMatch || !pathMatch) return url;
    const pathKey = `${pathMatch[1].toLowerCase()}/${pathMatch[2].toLowerCase()}`;
    if (payloadMatch[2].toLowerCase() !== pathKey) return url;
    const expiresAt = Number(payloadMatch[1]);
    if (expiresAt - Math.floor(Date.now() / 1000) > 60) return url; // still fresh
    return signMegaplayUrl(url) ?? url;
  } catch {
    return url;
  }
}

/** Cheap liveness probe — the master playlist must answer with a real m3u8 body. */
async function playlistResolves(url: string, referer: string, timeoutMs = 3500): Promise<boolean> {
  try {
    const { data } = await axios.get<string>(url, {
      headers: { ...DEFAULT_HEADERS, Accept: '*/*', Referer: referer },
      timeout: timeoutMs,
      responseType: 'text',
      transformResponse: [(d) => d],
      validateStatus: (status) => status < 400,
    });
    return typeof data === 'string' && data.includes('#EXTM3U');
  } catch {
    return false;
  }
}

interface MegaplayCandidate {
  url: string;
  /** true when the URL came out of the AES `enc` blob (those are path-locked / need a token). */
  decrypted: boolean;
}

/** Normalise a /stream/getSources payload into candidate stream URLs, best first. */
function collectMegaplayCandidates(payload: unknown): {
  candidates: MegaplayCandidate[];
  tracks: SubtitleTrack[];
} {
  const body = payload as {
    sources?: unknown;
    enc?: unknown;
    file?: unknown;
    tracks?: SubtitleTrack[];
  } | null;

  const candidates: MegaplayCandidate[] = [];
  const seen = new Set<string>();
  const push = (value: unknown, decrypted = false) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const url = value.trim();
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, decrypted });
  };

  const sources = body?.sources;
  if (typeof sources === 'string') push(sources);
  else if (Array.isArray(sources)) {
    for (const entry of sources) push((entry as { file?: string; url?: string })?.file ?? (entry as { url?: string })?.url);
  } else if (sources && typeof sources === 'object') {
    const source = sources as { file?: string; url?: string };
    push(source.file ?? source.url);
  }
  push(body?.file);

  if (typeof body?.enc === 'string' && body.enc) {
    const text = aesCbcDecrypt(body.enc, MEGAPLAY_AES_KEY, MEGAPLAY_AES_IV);
    const file = text ? pickFileFromText(text) : null;
    if (file) push(file, true);
    else megaplayDebug('enc payload could not be decrypted with the bundled key/iv');
  }

  // One mirror serves the stream from a host that only answers subtitle requests.
  for (const candidate of [...candidates]) {
    if (candidate.url.includes('fetch.nexabloom.top')) {
      push(candidate.url.replace('fetch.nexabloom.top', 'ncdn.imgnex.top'), candidate.decrypted);
    }
  }

  const tracks = Array.isArray(body?.tracks)
    ? body.tracks.filter((track): track is SubtitleTrack => Boolean(track?.file))
    : [];

  return { candidates, tracks };
}

/** Stream id lives in the <title> ("File 43070 - MegaPlay") and/or a `data-id` attribute. */
function findMegaplayId(html: string): string | null {
  return (
    html.match(/<title>\s*File\s+(\d+)/i)?.[1] ??
    html.match(/data-id=["'](\d+)["']/i)?.[1] ??
    null
  );
}

/** The player URL may carry the CDN selector (?s=tcdn) that getSources needs. */
function megaplaySValue(embedUrl?: string): string | null {
  try {
    return embedUrl ? new URL(embedUrl).searchParams.get('s') : null;
  } catch {
    return null;
  }
}

async function fetchMegaplayPayload(url: string, referer: string): Promise<unknown> {
  const { data } = await axios.get(url, {
    headers: {
      ...DEFAULT_HEADERS,
      Accept: 'application/json, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
    },
    timeout: 6000,
  });
  return data;
}

async function _doMegaplay(
  host: string,
  html: string,
  referer: string,
  embedUrl?: string
): Promise<ExtractedStream | null> {
  // The id lives in the <title> ("File 43070 - MegaPlay") on current players and
  // in a `data-id` attribute on some mirrors — try both, newest shape first.
  const dataId = html.match(/data-id=["'](\d+)["']/i)?.[1];
  const ids = [html.match(/<title>\s*File\s+(\d+)/i)?.[1], dataId].filter(
    (value, index, all): value is string => Boolean(value) && all.indexOf(value) === index
  );

  if (!ids.length) {
    megaplayDebug('no stream id found on page', { host, html: html.slice(0, 200) });
    return null;
  }

  const sParam = megaplaySValue(embedUrl);

  // Walk id × endpoint × cdn "s" combinations until one returns a usable
  // payload. In practice the first attempt wins; an endpoint that answers with
  // an unusable body is marked dead so we don't keep hammering it.
  const sValues = [sParam, 'tcdn'].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);

  let lastError = '';
  const deadEndpoints = new Set<string>();

  for (const id of ids) {
    for (const endpoint of ['stream/getSources', 'stream/getSourcesNew']) {
      const label = `${endpoint}?id=${id}`;
      if (deadEndpoints.has(label)) continue;

      for (const s of [...sValues, null]) {
        const attempt = `https://${host}/${endpoint}?id=${encodeURIComponent(id)}${s ? `&s=${encodeURIComponent(s)}` : ''}`;

        let payload: unknown;
        try {
          payload = await fetchMegaplayPayload(attempt, referer);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          continue;
        }

        const { candidates, tracks } = collectMegaplayCandidates(payload);
        if (!candidates.length) {
          lastError = `no stream url in getSources payload (${Object.keys((payload ?? {}) as object).join(',') || 'empty'})`;
          deadEndpoints.add(label);
          break;
        }

        const signCandidate = (candidate: MegaplayCandidate) =>
          candidate.decrypted && !/[?&]token=/i.test(candidate.url)
            ? signMegaplayUrl(candidate.url)
            : null;

        // Best guess if nothing can be verified: the signed form of the first
        // candidate — exactly what the site's own player would request.
        let chosen = signCandidate(candidates[0]) ?? candidates[0].url;

        if (candidates.length === 1 && !candidates[0].decrypted) {
          // Classic plaintext payload — the URL is used as-is by the player.
          megaplayDebug('plaintext source accepted without probing', { host, m3u8: chosen });
        } else {
          // Encrypted/path-locked streams need the player's HMAC token: sign,
          // probe, and keep whichever variant actually answers.
          let verified: string | null = null;
          for (const candidate of candidates) {
            const signed = signCandidate(candidate);
            if (signed && (await playlistResolves(signed, referer))) {
              verified = signed;
              break;
            }
            if (await playlistResolves(candidate.url, referer)) {
              verified = candidate.url;
              break;
            }
          }
          if (verified) chosen = verified;
          else megaplayDebug('no candidate playlist verified — using best guess', { host, chosen });
        }

        // Dead host workaround kept from the previous implementation.
        if (chosen.includes('mewstream.buzz')) {
          let replacementHost = '1oe.lostproject.club';
          const firstTrack = tracks.find((t) => t.file && !t.file.includes('mewstream.buzz'));
          if (firstTrack) {
            try {
              replacementHost = new URL(firstTrack.file).host;
            } catch {
              /* keep default */
            }
          }
          try {
            const parsed = new URL(chosen);
            parsed.host = replacementHost;
            chosen = parsed.toString();
          } catch {
            /* keep original */
          }
        }

        megaplayDebug('resolved', { host, attempt, candidates: candidates.length, m3u8: chosen });
        return { m3u8: chosen, referer, tracks };
      }
    }
  }

  console.error(`[extractMegaplay] Failed for ${host}: ${lastError || 'no usable payload'}`);
  return null;
}

/** Small, bounded brute-force: pull aes key/iv candidates out of the player bundle. */
async function megaplayScriptKeyPairs(
  host: string,
  html: string,
  referer: string
): Promise<Array<[string, string]>> {
  try {
    const origin = `https://${host}/`;
    const scriptUrls = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
      .map((m) => {
        try {
          return new URL(m[1], origin).toString();
        } catch {
          return null;
        }
      })
      .filter((url): url is string => Boolean(url))
      .slice(0, 8);

    const bodies = await Promise.all(
      scriptUrls.map((url) =>
        axios
          .get<string>(url, { headers: { ...DEFAULT_HEADERS, Referer: referer }, timeout: 6000, responseType: 'text' })
          .then((res) => String(res.data))
          .catch(() => null)
      )
    );

    const strings: string[] = [];
    for (const body of bodies) {
      if (!body || !/AES-CBC|getSources|createDecipher|subtle/i.test(body)) continue;
      for (const match of body.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)) {
        let value = match[2];
        try {
          value = JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
        } catch {
          /* keep raw literal */
        }
        if (Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 32) strings.push(value);
      }
      if (strings.length > 600) break;
    }

    const unique = [...new Set(strings)];
    const keys = unique.filter((value) => Buffer.byteLength(value) <= 32).slice(0, 120);
    const ivs = unique.filter((value) => Buffer.byteLength(value) === 16);
    return keys.flatMap((key) => ivs.map((iv) => [key, iv] as [string, string]));
  } catch (err) {
    megaplayDebug('script scan failed', err instanceof Error ? err.message : err);
    return [];
  }
}

export async function extractMegaplay(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const check = await validateSafeUrl(embedUrl);
    if (!check.safe) return null;

    const host = new URL(embedUrl).host;
    const referer = 'https://' + host + '/';
    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 5000,
    });

    const result = await _doMegaplay(host, html, referer, embedUrl);
    if (result) return result;

    // Static key/iv failed (or the payload shape is new): try keys scraped from
    // the player bundle before giving up.
    const pairs = await megaplayScriptKeyPairs(host, html, referer);
    if (!pairs.length) return null;

    const id = findMegaplayId(html);
    if (!id) return null;

    const sParam = megaplaySValue(embedUrl);
    const endpoint = sParam
      ? `https://${host}/stream/getSources?id=${encodeURIComponent(id)}&s=${encodeURIComponent(sParam)}`
      : `https://${host}/stream/getSources?id=${encodeURIComponent(id)}`;

    let payload: unknown;
    try {
      payload = await fetchMegaplayPayload(endpoint, referer);
    } catch {
      return null;
    }

    const enc = (payload as { enc?: string })?.enc;
    if (typeof enc !== 'string' || !enc) return null;

    for (const [key, iv] of pairs) {
      const text = aesCbcDecrypt(enc, key, iv);
      const file = text ? pickFileFromText(text) : null;
      if (!file) continue;
      const signed = signMegaplayUrl(file) ?? file;
      const m3u8 = (await playlistResolves(signed, referer)) ? signed : (await playlistResolves(file, referer)) ? file : signed;
      megaplayDebug('resolved via scraped key', { host, m3u8 });
      return { m3u8, referer, tracks: [] };
    }

    console.error(`[extractMegaplay] Scraped ${pairs.length} key/iv pair(s) from ${host} but none decrypted the payload`);
    return null;
  } catch (err) {
    console.error('Megaplay extraction failed:', err);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Kiwi mapper side-channel
//
// Live shape (mapper.nekostream.site/api/mal/<malId>/<epNum>/<timestamp>):
//   {
//     "Kiwi": {
//       "sub": { "download": { "360p": "https://pahe.nekostream.site/HEiRj", … } },
//       "dub": { "download": { … } }
//     },
//     "status": { … }
//   }
//
// The old code looked for `entry.url` and bailed with "No server code found",
// which is exactly the error the site logs produced. Handle both shapes:
//   • `{ url }` (an anikoto server code)     → /ajax/server?get= as before
//   • `{ download: { "1080p": url, … } }`    → surface the direct links
// ════════════════════════════════════════════════════════════════════════════

const QUALITY_ORDER = ['1080p', '720p', '480p', '360p'];

function pickDownload(download: unknown): { url: string; downloads?: Record<string, string> } | null {
  if (!download) return null;
  if (typeof download === 'string') return { url: download };

  if (typeof download === 'object') {
    const entries = Object.entries(download as Record<string, unknown>)
      .filter(([, value]) => typeof value === 'string' && value)
      .map(([quality, value]) => [quality, value as string] as const);
    if (!entries.length) return null;
    const sorted = [...entries].sort((a, b) => {
      const ai = QUALITY_ORDER.indexOf(a[0]);
      const bi = QUALITY_ORDER.indexOf(b[0]);
      return (ai === -1 ? QUALITY_ORDER.length : ai) - (bi === -1 ? QUALITY_ORDER.length : bi);
    });
    return { url: sorted[0][1], downloads: Object.fromEntries(entries) };
  }

  return null;
}

/** A real anikoto `data-link-id` server code is opaque — never an absolute URL. */
function looksLikeServerCode(value: string): boolean {
  return value.length > 0 && !/^https?:\/\//i.test(value);
}

async function _tryKiwiMapperUrl(
  mapperBase: string,
  malId: string,
  epNum: string | number,
  timestamp: string,
  type: 'sub' | 'dub',
  baseUrl: string
): Promise<ExtractedStream> {
  const mapperUrl = `${mapperBase}/${encodeURIComponent(malId)}/${encodeURIComponent(epNum)}/${encodeURIComponent(timestamp)}`;
  const { data } = await axios.get(mapperUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      Referer: baseUrl + '/',
      Origin: baseUrl,
    },
    timeout: 8000,
  });

  if (!data || typeof data !== 'object') throw new Error('Invalid response');

  let serverCode: string | null = null;
  let directUrl: string | null = null;
  let downloads: Record<string, string> | undefined;

  for (const key of Object.keys(data)) {
    if (key === 'status') continue;
    const entry = (data as Record<string, Record<string, unknown>>)[key]?.[type];
    if (!entry || typeof entry !== 'object') continue;

    const urlValue = (entry as { url?: unknown }).url;
    if (typeof urlValue === 'string' && urlValue) {
      if (looksLikeServerCode(urlValue)) {
        serverCode = urlValue;
        break;
      }
      directUrl = directUrl ?? urlValue;
    }

    const picked = pickDownload((entry as { download?: unknown }).download);
    if (picked) {
      if (looksLikeServerCode(picked.url)) {
        serverCode = picked.url;
        break;
      }
      directUrl = directUrl ?? picked.url;
      downloads = downloads ?? picked.downloads;
    }
  }

  if (!serverCode && !directUrl) throw new Error('No server code or download link found');

  if (serverCode) {
    const { data: serverData } = await axios.get(`${baseUrl}/ajax/server?get=${serverCode}`, {
      headers: { ...DEFAULT_HEADERS, 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 5000,
    });

    let embedUrl: string | null = serverData?.result?.url ?? null;
    if (!embedUrl) throw new Error('No embed URL');
    if (embedUrl.includes('#')) {
      try {
        embedUrl = Buffer.from(embedUrl.split('#')[1], 'base64').toString('utf-8');
      } catch {
        /* keep the raw url */
      }
    }

    const referer = 'https://kwik.cx2.mewcdn.online/';
    const tracks = await parseM3u8Subtitles(embedUrl, referer);
    return { m3u8: embedUrl, referer, tracks, downloads };
  }

  // No server code — the mapper only carries direct download links (mp4).
  // If the link happens to point at one of our known embed hosts, resolve it,
  // otherwise hand the download links back as-is instead of erroring out.
  if (directUrl) {
    const knownEmbedHost = /megaplay\.|vidwish\.|megacloud\.|vidtube\./i.test(directUrl);
    if (knownEmbedHost) {
      const resolved = await extractStreamUrl(directUrl).catch(() => null);
      if (resolved) return { ...resolved, downloads: downloads ?? resolved.downloads };
    }
    return { m3u8: null, referer: baseUrl + '/', tracks: [], downloads };
  }

  throw new Error('Mapper returned no resolvable link');
}

export async function extractKiwiMapper(
  malId: string,
  epNum: string | number,
  timestamp: string,
  type: 'sub' | 'dub',
  baseUrl: string
): Promise<ExtractedStream | null> {
  // Race all mapper URLs in parallel — use whichever responds successfully first
  try {
    return await Promise.any(
      KIWI_MAPPER_URLS.map((mapperBase) =>
        _tryKiwiMapperUrl(mapperBase, malId, epNum, timestamp, type, baseUrl)
      )
    );
  } catch (err) {
    // AggregateError: all URLs failed
    const msg = err instanceof AggregateError
      ? err.errors.map((e: Error) => e?.message).join('; ')
      : (err instanceof Error ? err.message : String(err));
    console.error(`[extractKiwiMapper] All mapper URLs failed (${type}):`, msg);
    return null;
  }
}

export async function extractVidstream(
  embedUrl: string,
  referer: string
): Promise<ExtractedStream | null> {
  try {
    const check = await validateSafeUrl(embedUrl);
    if (!check.safe) return null;

    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 8000,
    });

    const epIdMatch = html.match(/data-ep-id=["'](\d+)["']/);
    const typeMatch = html.match(/type:\s*'(\w+)'/);
    const domain2Match = html.match(/domain2_url:\s*'([^']+)'/);

    if (!epIdMatch || !typeMatch || !domain2Match) return null;

    const epId = epIdMatch[1];
    const epType = typeMatch[1];
    const domain2 = domain2Match[1].trim();

    const saveDataUrl = `${domain2}/save_data.php?id=${epId}-${epType}`;
    const { data } = await axios.get(saveDataUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 8000,
    });

    const sources = data?.data?.sources ?? [];
    const tracks: SubtitleTrack[] = data?.data?.tracks ?? [];
    const m3u8 = sources[0]?.url ?? null;

    if (!m3u8) return null;

    return { m3u8, referer: domain2 + '/', tracks };
  } catch (err) {
    console.error('[extractVidstream] Failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

async function _doMegacloud(
  embedUrl: string,
  html: string,
  referer: string
): Promise<ExtractedStream | null> {
  const origin = new URL(embedUrl).origin;

  const match1 = html.match(/\b[a-zA-Z0-9]{48}\b/);
  const match2 = html.match(/\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b.*?\b([a-zA-Z0-9]{16})\b/);
  const nonce = match1?.[0] || (match2 ? match2[1] + match2[2] + match2[3] : null);

  if (!nonce) return null;

  const sId =
    embedUrl.split('/e-1/')[1]?.split('?')[0] ??
    embedUrl.split('/').pop()?.split('?')[0];
  const sourcesUrl = `${origin}/embed-2/v3/e-1/getSources?id=${sId}&_k=${nonce}`;

  const { data } = await axios.get(sourcesUrl, {
    headers: {
      ...DEFAULT_HEADERS,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: referer,
    },
    timeout: 5000,
  });

  const tracks: SubtitleTrack[] = data?.tracks || [];

  if (!data.encrypted || data.sources?.[0]?.file?.includes('.m3u8')) {
    return data.sources?.[0]?.file ? { m3u8: data.sources[0].file, referer, tracks } : null;
  }

  const keys = await getMegacloudKeys();
  const secret = keys['mega'];

  const decryptUrl =
    `https://megacloud-api-nine.vercel.app/` +
    `?encrypted_data=${encodeURIComponent(data.sources[0].file)}` +
    `&nonce=${encodeURIComponent(nonce)}` +
    `&secret=${encodeURIComponent(secret)}`;

  try {
    const { data: decrypted } = await axios.get(decryptUrl, { timeout: 5000 });
    const m3u8 = (typeof decrypted === 'string' ? decrypted : JSON.stringify(decrypted)).match(
      /"file":"(.*?)"/
    )?.[1];
    return m3u8 ? { m3u8, referer, tracks } : null;
  } catch (err) {
    console.error('Megacloud remote decrypt failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export async function extractMegacloud(embedUrl: string): Promise<ExtractedStream | null> {
  try {
    const check = await validateSafeUrl(embedUrl);
    if (!check.safe) return null;

    const origin = new URL(embedUrl).origin;
    const referer = origin + '/';
    const { data: html } = await axios.get<string>(embedUrl, {
      headers: { ...DEFAULT_HEADERS, Referer: referer },
      timeout: 5000,
    });
    return await _doMegacloud(embedUrl, html, referer);
  } catch (err) {
    console.error('Megacloud extraction failed:', err);
    return null;
  }
}

export async function extractStreamUrl(embedUrl: string): Promise<ExtractedStream | null> {
  const check = await validateSafeUrl(embedUrl);
  if (!check.safe) return null;

  const hostname = new URL(embedUrl).hostname;

  if (
    hostname.includes('megaplay.buzz') ||
    hostname.includes('vidwish.live') ||
    hostname.includes('megacloud.bloggy.click')
  ) {
    const megaplayUrl = embedUrl
      .replace('vidwish.live', 'megaplay.buzz')
      .replace('megacloud.bloggy.click', 'megaplay.buzz');
    return extractMegaplay(megaplayUrl);
  }

  if (hostname.includes('megacloud.blog')) {
    return extractMegacloud(embedUrl);
  }

  if (hostname.includes('vidtube.site')) {
    return extractMegaplay(embedUrl);
  }

  let currentUrl = embedUrl;

  for (let i = 0; i < 2; i++) {
    let html = '';
    try {
      let host = new URL(currentUrl).host;
      let referer = 'https://' + host + '/';
      let response;

      try {
        response = await axios.get<string>(currentUrl, {
          headers: { ...DEFAULT_HEADERS, Referer: referer },
          timeout: 5000,
        });
      } catch {
        if (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click')) {
          const fallbackUrl = currentUrl
            .replace('vidwish.live', 'megaplay.buzz')
            .replace('megacloud.bloggy.click', 'megaplay.buzz');
          host = new URL(fallbackUrl).host;
          referer = 'https://' + host + '/';
          response = await axios.get<string>(fallbackUrl, {
            headers: { ...DEFAULT_HEADERS, Referer: referer },
            timeout: 5000,
          });
          currentUrl = fallbackUrl;
        } else {
          return null;
        }
      }

      html = response.data;

      const isErrorPage =
        html.includes('Error -') ||
        html.includes('error-container') ||
        html.includes("doesn't exist");
      if (
        isErrorPage &&
        (currentUrl.includes('vidwish.live') || currentUrl.includes('megacloud.bloggy.click'))
      ) {
        const fallbackUrl = currentUrl
          .replace('vidwish.live', 'megaplay.buzz')
          .replace('megacloud.bloggy.click', 'megaplay.buzz');
        host = new URL(fallbackUrl).host;
        referer = 'https://' + host + '/';
        response = await axios.get<string>(fallbackUrl, {
          headers: { ...DEFAULT_HEADERS, Referer: referer },
          timeout: 5000,
        });
        currentUrl = fallbackUrl;
        html = response.data;
      }

      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (iframeMatch) {
        const resolved = new URL(iframeMatch[1], currentUrl).toString();
        if (resolved !== currentUrl) {
          currentUrl = resolved;
          continue;
        }
      }

      const finalHost = new URL(currentUrl).hostname;
      const finalReferer = 'https://' + new URL(currentUrl).host + '/';

      if (
        finalHost.includes('megaplay.buzz') ||
        finalHost.includes('vidwish.live') ||
        finalHost.includes('vidtube.site')
      ) {
        return await _doMegaplay(new URL(currentUrl).host, html, finalReferer, currentUrl);
      }
      if (finalHost.includes('megacloud.blog')) {
        return await extractMegacloud(currentUrl);
      }

      // Unknown host, but the markup looks like the MegaPlay player (host
      // rotations happen often enough that hard-coding hosts keeps biting us).
      if (/<title>\s*File\s+\d+/i.test(html) || (/data-id=["']\d+["']/i.test(html) && /getSources/i.test(html))) {
        return await _doMegaplay(new URL(currentUrl).host, html, finalReferer, currentUrl);
      }

      return null;
    } catch (err) {
      console.error(`[extractStreamUrl] Failed for ${currentUrl}:`, err);
      return null;
    }
  }

  return null;
}
