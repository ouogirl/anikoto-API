import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import http from 'http';
import https from 'https';
import { BASE_URL, DEFAULT_HEADERS } from './constants';
import { validateSafeUrl } from './security';

// Connection pooling agents with HTTP Keep-Alive
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 50,
  maxFreeSockets: 10,
  timeout: 30000,
});

/**
 * Reusable Axios client with connection pooling and response size limits.
 */
export const apiClient: AxiosInstance = axios.create({
  httpAgent,
  httpsAgent,
  timeout: 15_000,
  maxContentLength: 10 * 1024 * 1024, // 10MB max body limit to prevent memory bomb
  maxBodyLength: 10 * 1024 * 1024,
});

/**
 * Resolve and validate the target URL.
 */
async function resolveAndValidateUrl(path: string): Promise<string> {
  const targetUrl = path.startsWith('http') ? path : `${BASE_URL.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  
  if (path.startsWith('http')) {
    const validation = await validateSafeUrl(targetUrl);
    if (!validation.safe) {
      throw new Error(`SSRF blocked unsafe URL "${path}": ${validation.error}`);
    }
  }

  return targetUrl;
}

/**
 * Fetch an HTML page from anikoto and return a Cheerio instance.
 */
export async function fetchPage(path: string, customHeaders?: Record<string, string>): Promise<cheerio.CheerioAPI> {
  const url = await resolveAndValidateUrl(path);
  const response = await apiClient.get<string>(url, {
    headers: {
      ...DEFAULT_HEADERS,
      ...customHeaders,
    },
    responseType: 'text',
  });
  return cheerio.load(response.data);
}

/**
 * Fetch JSON from the site's internal AJAX endpoints.
 * @param extraHeaders - Optional additional headers to merge (e.g. a per-request Referer).
 */
export async function fetchJson<T = unknown>(
  path: string,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const url = await resolveAndValidateUrl(path);
  const response = await apiClient.get<T>(url, {
    headers: {
      ...DEFAULT_HEADERS,
      Accept: 'application/json, text/javascript, */*',
      'X-Requested-With': 'XMLHttpRequest',
      ...extraHeaders,
    },
  });
  return response.data;
}
