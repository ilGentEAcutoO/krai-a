// Rate limiter under flood: IPv6 clients are keyed by /64 (address rotation
// buys nothing), global caps are always counted, a full table degrades new
// clients into a shared overflow bucket (never unlimited), and expired
// buckets are swept so the table cannot grow forever.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  take, resetLimits, clientBucket, sweepBuckets, bucketCount, MAX_KEYS,
} from '../src/ratelimit.js';

afterEach(() => resetLimits());

describe('clientBucket()', () => {
  it('keys IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
    assert.equal(clientBucket('2001:db8:1:2:aaaa::1'), clientBucket('2001:0db8:0001:0002:bbbb:cccc:dddd:eeee'));
    assert.notEqual(clientBucket('2001:db8:1:2::1'), clientBucket('2001:db8:1:3::1'));
    assert.equal(clientBucket('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientBucket('203.0.113.7'), '203.0.113.7');
    assert.equal(clientBucket('fe80::1%eth0'), clientBucket('fe80::2'));
    assert.equal(clientBucket('unknown'), 'unknown');
  });
});

describe('take() under flood', () => {
  it('one /64 shares a per-IP bucket (rotation inside a /64 is useless)', () => {
    assert.equal(take('demo:start:ip:2001:db8:9:9::1', 1, 60000, 1000).ok, true);
    assert.equal(take('demo:start:ip:2001:db8:9:9:ffff::2', 1, 60000, 1000).ok, false);
    assert.equal(take('demo:start:ip:2001:db8:9:a::1', 1, 60000, 1000).ok, true, 'another /64 is another client');
  });

  it('a full table never lets global caps pass uncounted', () => {
    for (let i = 0; i < MAX_KEYS; i += 1) take(`flood:ip:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 5, 3600000, 1000);
    assert.ok(bucketCount() >= MAX_KEYS);
    assert.equal(take('live:day', 2, 86400000, 1000).ok, true);
    assert.equal(take('live:day', 2, 86400000, 1000).ok, true);
    assert.equal(take('live:day', 2, 86400000, 1000).ok, false, 'global cap still enforced');
  });

  it('a full table puts NEW clients in a shared overflow bucket, not unlimited', () => {
    for (let i = 0; i < MAX_KEYS; i += 1) take(`flood:ip:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 5, 3600000, 1000);
    const results = [];
    for (let i = 0; i < 10; i += 1) results.push(take(`live:try:ip:192.0.2.${i}`, 3, 3600000, 1000).ok);
    assert.equal(results.filter(Boolean).length, 3, 'all new IPs share one bucket of 3');
  });

  it('expired buckets are swept (on demand and by the timer)', () => {
    take('a:ip:198.51.100.1', 5, 60000, 1000);
    take('b:ip:198.51.100.2', 5, 3600000, 1000);
    assert.equal(bucketCount(), 2);
    assert.equal(sweepBuckets(1000 + 61000), 1, 'the 1-minute bucket expired');
    assert.equal(bucketCount(), 1);
  });

  it('a full table sweeps expired buckets before overflowing', () => {
    for (let i = 0; i < MAX_KEYS; i += 1) take(`old:ip:10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`, 5, 60000, 1000);
    // An hour later every old bucket has expired: a new client gets its own bucket again.
    assert.equal(take('demo:start:ip:192.0.2.50', 1, 3600000, 3600000 + 2000).ok, true);
    assert.equal(take('demo:start:ip:192.0.2.51', 1, 3600000, 3600000 + 2000).ok, true, 'not lumped into overflow');
    assert.ok(bucketCount() < 10);
  });
});
