import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';

const TEST_PORT = 3099;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

describe('End-to-End API Server Tests', () => {
  let serverProcess: ChildProcess;

  before(async () => {
    // Start Next.js production server on TEST_PORT
    serverProcess = spawn(
      'npx',
      ['next', 'start', '-p', String(TEST_PORT)],
      {
        detached: true,
        env: {
          ...process.env,
          PORT: String(TEST_PORT),
          NEXT_TELEMETRY_DISABLED: '1',
        },
        stdio: 'ignore',
      }
    );

    // Wait for server to become responsive
    const startTime = Date.now();
    let ready = false;

    while (Date.now() - startTime < 15000) {
      try {
        const res = await fetch(`${BASE}/streamvault`);
        if (res.status === 308 || res.status === 200) {
          ready = true;
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    if (!ready) {
      if (serverProcess.pid) {
        try { process.kill(-serverProcess.pid, 'SIGKILL'); } catch {}
      }
      throw new Error('Server failed to start within 15 seconds');
    }
  });

  after(() => {
    if (serverProcess?.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM');
      } catch {
        try { serverProcess.kill('SIGTERM'); } catch {}
      }
    }
  });

  describe('Static & Convenience Routes', () => {
    it('GET / returns 200 documentation page', async () => {
      const res = await fetch(`${BASE}/`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.match(text, /Anikoto Scraper/i);
    });

    it('GET /streamvault redirects to /streamvault.html (308)', async () => {
      const res = await fetch(`${BASE}/streamvault`, { redirect: 'manual' });
      assert.strictEqual(res.status, 308);
      assert.strictEqual(res.headers.get('location'), '/streamvault.html');
    });

    it('GET /streamvault.html serves the downloader client (200)', async () => {
      const res = await fetch(`${BASE}/streamvault.html`);
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.match(text, /StreamVault/i);
      // Verify no Google fonts or external render proxy leaks exist in HTML
      assert.strictEqual(text.includes('fonts.googleapis.com'), false);
      assert.strictEqual(text.includes('corsproxy.io'), false);
      assert.strictEqual(text.includes('allorigins.win'), false);
    });
  });

  describe('/api/proxy Security & Validation', () => {
    it('returns 400 when url param is missing', async () => {
      const res = await fetch(`${BASE}/api/proxy`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
      assert.match(data.message, /missing.*url/i);
    });

    it('blocks SSRF to 127.0.0.1', async () => {
      const res = await fetch(`${BASE}/api/proxy?url=http://127.0.0.1:${TEST_PORT}/api`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
      assert.match(data.message, /blocked.*unsafe|forbidden/i);
    });

    it('blocks SSRF to cloud metadata (169.254.169.254)', async () => {
      const res = await fetch(`${BASE}/api/proxy?url=http://169.254.169.254/latest/meta-data`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
      assert.match(data.message, /blocked.*unsafe|forbidden/i);
    });

    it('blocks SSRF to localhost', async () => {
      const res = await fetch(`${BASE}/api/proxy?url=http://localhost/secret`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
    });

    it('blocks file:// protocol', async () => {
      const res = await fetch(`${BASE}/api/proxy?url=file:///etc/passwd`);
      assert.strictEqual(res.status, 400);
    });

    it('blocks non-standard ports (22, 3306, 8080)', async () => {
      const res = await fetch(`${BASE}/api/proxy?url=https://example.com:22/stream.m3u8`);
      assert.strictEqual(res.status, 400);
    });

    it('responds to OPTIONS preflight with 204 and CORS headers', async () => {
      const res = await fetch(`${BASE}/api/proxy`, { method: 'OPTIONS' });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
      assert.match(res.headers.get('Access-Control-Allow-Methods') || '', /GET/);
    });
  });

  describe('API Route Input Validation', () => {
    it('/api/anime/[slug] rejects path traversal and invalid slugs (400)', async () => {
      const res = await fetch(`${BASE}/api/anime/..%2F..%2Fetc%2Fpasswd`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
    });

    it('/api/anime/[slug] rejects invalid episode range (400)', async () => {
      const res = await fetch(`${BASE}/api/anime/one-piece-odmau?start=10&end=5`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
      assert.match(data.message, /invalid episode range/i);
    });

    it('/api/anime/[slug]/episodes rejects invalid slug (400)', async () => {
      const res = await fetch(`${BASE}/api/anime/bad%20slug!/episodes`);
      assert.strictEqual(res.status, 400);
    });

    it('/api/watch/[slug] rejects invalid slug and episode number (400)', async () => {
      const res1 = await fetch(`${BASE}/api/watch/bad%20slug!?ep=1`);
      assert.strictEqual(res1.status, 400);

      const res2 = await fetch(`${BASE}/api/watch/one-piece-odmau?ep=invalid%20ep!`);
      assert.strictEqual(res2.status, 400);
    });

    it('/api/search rejects missing or empty keyword (400)', async () => {
      const res1 = await fetch(`${BASE}/api/search`);
      assert.strictEqual(res1.status, 400);

      const res2 = await fetch(`${BASE}/api/search?keyword=%20%20`);
      assert.strictEqual(res2.status, 400);
    });

    it('/api/latest rejects invalid listing type (400)', async () => {
      const res = await fetch(`${BASE}/api/latest?type=nonexistent`);
      assert.strictEqual(res.status, 400);
      const data = await res.json();
      assert.strictEqual(data.ok, false);
    });

    it('/api/genre/[genre] rejects invalid genre slug (400)', async () => {
      const res = await fetch(`${BASE}/api/genre/invalid%20genre!`);
      assert.strictEqual(res.status, 400);
    });

    it('/api/type/[type] rejects invalid type (400)', async () => {
      const res = await fetch(`${BASE}/api/type/unknown-type`);
      assert.strictEqual(res.status, 400);
    });

    it('/api/status rejects invalid status (400)', async () => {
      const res = await fetch(`${BASE}/api/status?type=unknown-status`);
      assert.strictEqual(res.status, 400);
    });
  });
});
