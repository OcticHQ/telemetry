/**
 * Agent receipts, checked against contract/SPOOL.md.
 *
 *   node --test test/receipts.test.ts
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { recordReceipt, resetReceiptsForTests } from '../src/receipts.ts';
import { resolveSpoolOptions, Spool } from '../src/spool.ts';
import { withSpoolDir } from './support/harness.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const FI_RECEIVED = {
  'airlock.destination': 'aa.example.in',
  'airlock.bytes': 1234,
  'airlock.ciphertext.digest': DIGEST,
  'airlock.duration.ms': 80,
};

const receiptFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir)).filter(name => /^receipt-.*\.json$/.test(name)).sort();

const saved = { ...process.env };
beforeEach(() => resetReceiptsForTests());
afterEach(() => {
  process.env = { ...saved };
});

describe('recordReceipt', () => {
  it('writes one file, ints as decimal strings, before any init()', async () => {
    await withSpoolDir(async dir => {
      process.env.OCTIC_SPOOL_DIR = dir;
      assert.equal(recordReceipt('fi.received', FI_RECEIVED), true);
      const [name, ...rest] = await receiptFiles(dir);
      assert.deepEqual(rest, []);
      const body = JSON.parse(await readFile(join(dir, name!), 'utf8')) as {
        receiptFormatVersion: number;
        type: string;
        attributes: Record<string, string>;
        occurredAt: string;
      };
      assert.equal(body.receiptFormatVersion, 1);
      assert.equal(body.type, 'fi.received');
      assert.equal(body.attributes['airlock.bytes'], '1234');
      assert.equal(body.attributes['airlock.duration.ms'], '80');
      assert.match(body.occurredAt, /Z$/);
      assert.deepEqual(
        (await readdir(dir)).filter(entry => entry.endsWith('.tmp')),
        [],
      );
    });
  });

  it('is false and writes nothing for anything off the vocabulary', async () => {
    await withSpoolDir(async dir => {
      process.env.OCTIC_SPOOL_DIR = dir;
      const bad: [string, Record<string, string | number>][] = [
        ['fi.received', { ...FI_RECEIVED, 'airlock.note': 'x' }],
        ['nope.nothing', {}],
        ['constructor', {}],
        ['input.read', {}],
        ['input.read', { 'airlock.bytes': '01' }],
        ['input.read', { 'airlock.bytes': -1 }],
        ['input.read', { 'airlock.bytes': 1.5 }],
        ['input.read', { 'airlock.bytes': 2 ** 53 }],
        ['input.read', { 'airlock.bytes': true as unknown as number }],
        ['input.read', { 'airlock.bytes': '__proto__' }],
        ['output.refused', { 'airlock.refusal.reason': 'Has Space' }],
      ];
      for (const [type, attributes] of bad) {
        assert.equal(
          recordReceipt(type, attributes),
          false,
          `${type} ${JSON.stringify(attributes)}`,
        );
      }
      assert.deepEqual(await receiptFiles(dir), []);
    });
  });

  it('refuses the 257th', async () => {
    await withSpoolDir(async dir => {
      process.env.OCTIC_SPOOL_DIR = dir;
      for (let index = 0; index < 256; index += 1) {
        assert.equal(recordReceipt('input.read', { 'airlock.bytes': 1 }), true);
      }
      assert.equal(recordReceipt('input.read', { 'airlock.bytes': 1 }), false);
      assert.equal((await receiptFiles(dir)).length, 256);
    });
  });

  it('is false on an unwritable spool', async () => {
    process.env.OCTIC_SPOOL_DIR = '/dev/null/nope';
    // Only the configured candidate is skipped; the cascade may still find a home,
    // so pin the cascade to the bad one with a live spool configured there.
    const spool = new Spool(resolveSpoolOptions({ enabled: true, dir: '/dev/null/nope' }), {
      endpoint: 'http://127.0.0.1:8400',
      signalPaths: { traces: '/v1/traces', logs: '/v1/logs' },
      contentType: 'application/json',
      contentEncoding: 'identity',
      serviceName: 'test',
      octicSchemaVersion: '1',
      sdkName: 'octichq-airlock-sdk-node',
      sdkVersion: '0.0.0',
      contentCapture: 'none',
    });
    assert.equal(recordReceipt('input.read', { 'airlock.bytes': 1 }), false);
    await spool.shutdown();
  });

  it('is false on an unsafe OCTIC_SPOOL_DIR rather than falling through the cascade', async () => {
    // Airlock reads only the directory it named, so a receipt anywhere else is lost.
    await withSpoolDir(async dir => {
      const unsafe = join(dir, 'unsafe');
      await mkdir(unsafe);
      await chmod(unsafe, 0o777);
      const fallback = join(dir, 'state');
      process.env.OCTIC_SPOOL_DIR = unsafe;
      process.env.XDG_STATE_HOME = fallback;
      assert.equal(recordReceipt('input.read', { 'airlock.bytes': 1 }), false);
      await assert.rejects(receiptFiles(join(fallback, 'octic', 'spool')), { code: 'ENOENT' });
      assert.deepEqual(await receiptFiles(unsafe), []);
    });
  });

  it('survives a full span spool under evict-oldest, and is never evicted', async () => {
    await withSpoolDir(async dir => {
      const spool = new Spool(resolveSpoolOptions({ enabled: true, dir, maxFiles: 1 }), {
        endpoint: 'http://127.0.0.1:8400',
        signalPaths: { traces: '/v1/traces', logs: '/v1/logs' },
        contentType: 'application/json',
        contentEncoding: 'identity',
        serviceName: 'test',
        octicSchemaVersion: '1',
        sdkName: 'octichq-airlock-sdk-node',
        sdkVersion: '0.0.0',
        contentCapture: 'none',
      });
      assert.equal(recordReceipt('input.read', { 'airlock.bytes': 1 }), true);
      for (let index = 0; index < 3; index += 1) {
        assert.equal(spool.write('traces', new TextEncoder().encode('{"resourceSpans":[]}')), true);
        await spool.forceFlush();
      }
      assert.equal((await receiptFiles(dir)).length, 1);
      assert.equal((await readdir(dir)).filter(name => name.endsWith('.otlp.json')).length, 1);
      await spool.shutdown();
    });
  });
});

describe('the character limit', () => {
  it('refuses a value over 512 characters that its shape would allow', async () => {
    await withSpoolDir(async dir => {
      process.env.OCTIC_SPOOL_DIR = dir;
      // Sixteen 32-character types fit fi_types at 527 characters; Airlock refuses them.
      const long = Array.from({ length: 16 }, () => 'A'.repeat(32)).join(',');
      const fits = Array.from({ length: 15 }, () => 'A'.repeat(32)).join(',');
      const purpose = { 'airlock.consent.purpose': '101' };
      const verified = (types: string) =>
        recordReceipt('consent.verified', { ...purpose, 'airlock.consent.fi_types': types });
      assert.equal(verified(long), false);
      assert.equal(verified(fits), true);
    });
  });
});

describe('warnings', () => {
  it('prints each distinct refusal once, without OCTIC_TELEMETRY_DEBUG', async () => {
    delete process.env.OCTIC_TELEMETRY_DEBUG;
    const seen: string[] = [];
    const listener = (warning: Error): void => {
      seen.push(warning.message);
    };
    process.on('warning', listener);
    try {
      assert.equal(recordReceipt('not.a.type', {}), false);
      assert.equal(recordReceipt('not.a.type', {}), false);
      await new Promise(resolve => setImmediate(resolve));
    } finally {
      process.off('warning', listener);
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0]!, /vocabulary/);
  });
});
