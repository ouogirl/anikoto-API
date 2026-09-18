import { describe, it } from 'node:test';
import assert from 'node:assert';
import { proxyLimiter, searchLimiter, getClientIp } from '../src/lib/rate-limiter.ts';

describe('Rate Limiter', () => {
  it('allows requests within threshold and tracks remaining count', () => {
    const ip = 'test-ip-1';
    const r1 = searchLimiter.check(ip);
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 59);

    const r2 = searchLimiter.check(ip);
    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 58);
  });

  it('proxyLimiter allows high throughput for streaming', () => {
    const ip = 'proxy-test-ip';
    const r1 = proxyLimiter.check(ip);
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 239);
  });

  it('extracts client IP safely from headers', () => {
    const req1 = new Request('http://localhost/api/test', {
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
    });
    assert.strictEqual(getClientIp(req1), '203.0.113.195');

    const req2 = new Request('http://localhost/api/test', {
      headers: { 'x-real-ip': '198.51.100.22' },
    });
    assert.strictEqual(getClientIp(req2), '198.51.100.22');

    const req3 = new Request('http://localhost/api/test');
    assert.strictEqual(getClientIp(req3), '127.0.0.1');
  });
});
