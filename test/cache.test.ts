import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import cache, { getOrSet, cacheGet, cacheSet, cacheDel, cacheStats } from '../src/lib/cache.ts';

describe('Cache Subsystem', () => {
  beforeEach(() => {
    cache.flushAll();
  });

  it('stores and retrieves values via getOrSet', async () => {
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return { hello: 'world' };
    };

    const res1 = await getOrSet('test:key1', fetcher, 60);
    assert.deepStrictEqual(res1, { hello: 'world' });
    assert.strictEqual(callCount, 1);

    // Second call must hit cache without invoking fetcher
    const res2 = await getOrSet('test:key1', fetcher, 60);
    assert.deepStrictEqual(res2, { hello: 'world' });
    assert.strictEqual(callCount, 1);
  });

  it('prevents cache stampede / thundering herd on concurrent cold requests', async () => {
    let callCount = 0;
    const slowFetcher = async () => {
      callCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { timestamp: Date.now() };
    };

    // Fire 20 concurrent requests simultaneously for the same cold key
    const promises = Array.from({ length: 20 }).map(() =>
      getOrSet('test:stampede', slowFetcher, 60)
    );

    const results = await Promise.all(promises);

    // All results must be identical
    assert.strictEqual(results.length, 20);
    for (const r of results) {
      assert.strictEqual(r.timestamp, results[0].timestamp);
    }

    // Fetcher must be called exactly once
    assert.strictEqual(callCount, 1);
  });

  it('cleans up in-flight state when fetcher fails', async () => {
    let callCount = 0;
    const failingFetcher = async () => {
      callCount++;
      throw new Error('Upstream failed');
    };

    await assert.rejects(
      async () => getOrSet('test:fail', failingFetcher, 60),
      /Upstream failed/
    );

    // Next request should try again and not be stuck waiting on a dead promise
    await assert.rejects(
      async () => getOrSet('test:fail', failingFetcher, 60),
      /Upstream failed/
    );

    assert.strictEqual(callCount, 2);
  });

  it('supports direct cacheGet, cacheSet, and cacheDel', () => {
    cacheSet('direct:key', { data: 123 }, 60);
    const val = cacheGet<{ data: number }>('direct:key');
    assert.deepStrictEqual(val, { data: 123 });

    cacheDel('direct:key');
    const missing = cacheGet('direct:key');
    assert.strictEqual(missing, undefined);
  });

  it('reports cacheStats accurately', () => {
    cacheSet('stat:1', 'a', 60);
    cacheSet('stat:2', 'b', 60);
    const stats = cacheStats();
    assert.strictEqual(stats.keys, 2);
    assert.strictEqual(stats.inFlightCount, 0);
  });
});
