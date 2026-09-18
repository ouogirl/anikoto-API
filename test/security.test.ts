import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isPrivateIPv4,
  isPrivateIPv6,
  isForbiddenHostname,
  validateSafeUrl,
  isValidSlug,
  isValidEpisodeNum,
  sanitizeFilename,
  isAllowedContentType,
} from '../src/lib/security.ts';

describe('Security & SSRF Prevention', () => {
  describe('isPrivateIPv4', () => {
    it('detects loopback addresses', () => {
      assert.strictEqual(isPrivateIPv4('127.0.0.1'), true);
      assert.strictEqual(isPrivateIPv4('127.0.1.1'), true);
      assert.strictEqual(isPrivateIPv4('127.255.255.255'), true);
    });

    it('detects RFC1918 private ranges', () => {
      assert.strictEqual(isPrivateIPv4('10.0.0.1'), true);
      assert.strictEqual(isPrivateIPv4('10.254.254.254'), true);
      assert.strictEqual(isPrivateIPv4('172.16.0.1'), true);
      assert.strictEqual(isPrivateIPv4('172.31.255.255'), true);
      assert.strictEqual(isPrivateIPv4('192.168.1.1'), true);
      assert.strictEqual(isPrivateIPv4('192.168.0.254'), true);
    });

    it('detects cloud metadata link-local address (169.254.169.254)', () => {
      assert.strictEqual(isPrivateIPv4('169.254.169.254'), true);
      assert.strictEqual(isPrivateIPv4('169.254.0.1'), true);
    });

    it('detects 0.0.0.0 and broadcast/multicast', () => {
      assert.strictEqual(isPrivateIPv4('0.0.0.0'), true);
      assert.strictEqual(isPrivateIPv4('224.0.0.1'), true);
      assert.strictEqual(isPrivateIPv4('255.255.255.255'), true);
    });

    it('allows public IPv4 addresses', () => {
      assert.strictEqual(isPrivateIPv4('8.8.8.8'), false);
      assert.strictEqual(isPrivateIPv4('1.1.1.1'), false);
      assert.strictEqual(isPrivateIPv4('93.184.216.34'), false);
    });
  });

  describe('isPrivateIPv6', () => {
    it('detects loopback and unspecified IPv6', () => {
      assert.strictEqual(isPrivateIPv6('::1'), true);
      assert.strictEqual(isPrivateIPv6('::'), true);
    });

    it('detects IPv4-mapped IPv6 loopback and metadata', () => {
      assert.strictEqual(isPrivateIPv6('::ffff:127.0.0.1'), true);
      assert.strictEqual(isPrivateIPv6('::ffff:169.254.169.254'), true);
      assert.strictEqual(isPrivateIPv6('::ffff:10.0.0.1'), true);
      assert.strictEqual(isPrivateIPv6('::ffff:8.8.8.8'), false);
    });

    it('detects ULA and link-local IPv6', () => {
      assert.strictEqual(isPrivateIPv6('fc00::1'), true);
      assert.strictEqual(isPrivateIPv6('fd12:3456:789a::1'), true);
      assert.strictEqual(isPrivateIPv6('fe80::1'), true);
    });
  });

  describe('isForbiddenHostname', () => {
    it('blocks localhost variants and internal domains', () => {
      assert.strictEqual(isForbiddenHostname('localhost'), true);
      assert.strictEqual(isForbiddenHostname('LOCALHOST'), true);
      assert.strictEqual(isForbiddenHostname('sub.localhost'), true);
      assert.strictEqual(isForbiddenHostname('internal.local'), true);
      assert.strictEqual(isForbiddenHostname('service.internal'), true);
      assert.strictEqual(isForbiddenHostname('router.lan'), true);
      assert.strictEqual(isForbiddenHostname('metadata.google.internal'), true);
      assert.strictEqual(isForbiddenHostname('instance-data'), true);
    });

    it('allows legitimate external domains', () => {
      assert.strictEqual(isForbiddenHostname('anikoto.net'), false);
      assert.strictEqual(isForbiddenHostname('cdn.mewstream.buzz'), false);
      assert.strictEqual(isForbiddenHostname('example.org'), false);
    });
  });

  describe('validateSafeUrl', () => {
    it('rejects invalid or missing URLs', async () => {
      const r1 = await validateSafeUrl('');
      assert.strictEqual(r1.safe, false);

      const r2 = await validateSafeUrl('not a url');
      assert.strictEqual(r2.safe, false);
    });

    it('rejects dangerous protocols (file, ftp, javascript, data)', async () => {
      const r1 = await validateSafeUrl('file:///etc/passwd');
      assert.strictEqual(r1.safe, false);

      const r2 = await validateSafeUrl('ftp://example.com/test');
      assert.strictEqual(r2.safe, false);

      const r3 = await validateSafeUrl('javascript:alert(1)');
      assert.strictEqual(r3.safe, false);
    });

    it('rejects credentials in URL', async () => {
      const r = await validateSafeUrl('https://admin:password@example.com/stream.m3u8');
      assert.strictEqual(r.safe, false);
      assert.match(r.error || '', /credentials/i);
    });

    it('rejects non-standard ports', async () => {
      const r1 = await validateSafeUrl('https://example.com:22/stream.m3u8');
      assert.strictEqual(r1.safe, false);

      const r2 = await validateSafeUrl('http://example.com:3306/stream.m3u8');
      assert.strictEqual(r2.safe, false);

      const r3 = await validateSafeUrl('http://example.com:8080/stream.m3u8');
      assert.strictEqual(r3.safe, false);
    });

    it('blocks SSRF to localhost and private IPs directly', async () => {
      const r1 = await validateSafeUrl('http://127.0.0.1/admin');
      assert.strictEqual(r1.safe, false);

      const r2 = await validateSafeUrl('http://169.254.169.254/latest/meta-data');
      assert.strictEqual(r2.safe, false);

      const r3 = await validateSafeUrl('http://10.0.0.5:80/secret');
      assert.strictEqual(r3.safe, false);

      const r4 = await validateSafeUrl('http://localhost:80/');
      assert.strictEqual(r4.safe, false);
    });

    it('validates safe public URLs', async () => {
      const r = await validateSafeUrl('https://example.com/playlist.m3u8', { skipDnsLookup: true });
      assert.strictEqual(r.safe, true);
      assert.strictEqual(r.url?.hostname, 'example.com');
    });
  });

  describe('Input validation helpers', () => {
    it('isValidSlug validates correct slugs and rejects traversal', () => {
      assert.strictEqual(isValidSlug('one-piece-odmau'), true);
      assert.strictEqual(isValidSlug('naruto_shippuden-123'), true);
      assert.strictEqual(isValidSlug('../../etc/passwd'), false);
      assert.strictEqual(isValidSlug('anime/watch'), false);
      assert.strictEqual(isValidSlug(''), false);
      assert.strictEqual(isValidSlug('a'.repeat(200)), false);
    });

    it('isValidEpisodeNum validates episode identifiers', () => {
      assert.strictEqual(isValidEpisodeNum('1'), true);
      assert.strictEqual(isValidEpisodeNum('12.5'), true);
      assert.strictEqual(isValidEpisodeNum('ep-1'), true);
      assert.strictEqual(isValidEpisodeNum(''), false);
      assert.strictEqual(isValidEpisodeNum('../1'), false);
    });

    it('sanitizeFilename prevents path traversal and control chars', () => {
      assert.strictEqual(sanitizeFilename('../../../secret.mp4'), '._._._secret.mp4');
      assert.strictEqual(sanitizeFilename('my<video>:file.mp4'), 'my_video_file.mp4');
      assert.strictEqual(sanitizeFilename('normal_name.mp4'), 'normal_name.mp4');
    });

    it('isAllowedContentType allows streaming media and rejects dangerous types', () => {
      assert.strictEqual(isAllowedContentType('application/vnd.apple.mpegurl'), true);
      assert.strictEqual(isAllowedContentType('application/x-mpegurl'), true);
      assert.strictEqual(isAllowedContentType('video/mp2t'), true);
      assert.strictEqual(isAllowedContentType('video/mp4'), true);
      assert.strictEqual(isAllowedContentType('text/vtt'), true);
      assert.strictEqual(isAllowedContentType('application/octet-stream'), true);

      assert.strictEqual(isAllowedContentType('text/html'), false);
      assert.strictEqual(isAllowedContentType('application/javascript'), false);
      assert.strictEqual(isAllowedContentType('application/x-sh'), false);
      assert.strictEqual(isAllowedContentType('application/x-executable'), false);
    });
  });
});
