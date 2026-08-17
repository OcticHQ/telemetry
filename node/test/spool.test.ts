/**
 * The spool, on its own — directory selection, file permissions, atomicity and
 * the bounds.
 *
 * These are the properties that make it safe to put a customer's prompts on a
 * customer's disk. Every one of them is invisible from the outside: a spool
 * that writes 0644 files into a world-writable directory behaves exactly like
 * one that does not, right up until it matters. The integration file covers
 * what reaches disk; this one covers where and how.
 *
 * The bounds are here for the other reason the spool can hurt a host process:
 * unbounded disk is as much of an outage as unbounded memory, and the SDK is a
 * guest.
 *
 *   node --test test/
 */
import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { resolveSpoolOptions, SEGMENT_SUFFIX, Spool, SPOOL_FORMAT_VERSION } from '../src/spool.ts';
import { segments, withSpoolDir } from './support/harness.ts';

const unhandled: unknown[] = [];
process.on('unhandledRejection', reason => unhandled.push(reason));
after(() => {
  assert.deepEqual(unhandled, [], 'the spool must not raise an unhandled rejection');
});

const MANIFEST = {
  endpoint: 'http://127.0.0.1:8400',
  signalPaths: { traces: '/v1/traces', logs: '/v1/logs' },
  contentType: 'application/json',
  contentEncoding: 'identity',
  serviceName: 'test',
  octicSchemaVersion: '1',
  sdkName: 'octic-node',
  sdkVersion: '0.0.0',
  contentCapture: 'none',
};

const spoolIn = (dir: string, overrides: Parameters<typeof resolveSpoolOptions>[0] = {}) =>
  new Spool(resolveSpoolOptions({ enabled: true, dir, ...overrides }), MANIFEST);

const body = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('writing a batch', () => {
  it('lands one file per batch, named by signal, and reports it in stats', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir);
      assert.equal(spool.write('traces', body('{"resourceSpans":[]}')), true);
      assert.equal(spool.write('logs', body('{"resourceLogs":[]}')), true);
      await spool.forceFlush();

      const names = await segments(dir);
      assert.equal(names.length, 2);
      assert.equal(names.filter(name => name.startsWith('traces-')).length, 1);
      assert.equal(names.filter(name => name.startsWith('logs-')).length, 1);
      assert.equal(spool.stats().written, 2);
      assert.equal(spool.stats().dropped, 0);

      await spool.shutdown();
    });
  });

  it('leaves no .tmp behind, so a reader can glob without racing the writer', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir);
      for (let index = 0; index < 5; index += 1) spool.write('traces', body(`{"n":${index}}`));
      await spool.forceFlush();

      const leftovers = (await readdir(dir)).filter(name => name.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
      await spool.shutdown();
    });
  });

  it('writes the body verbatim — what ingest would have received', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir);
      const payload = '{"resourceSpans":[{"scopeSpans":[]}]}';
      spool.write('traces', body(payload));
      await spool.forceFlush();

      const [name] = await segments(dir);
      assert.equal(await readFile(join(dir, name!), 'utf8'), payload);
      await spool.shutdown();
    });
  });
});

describe('the manifest', () => {
  it('describes the delivery and carries no credential', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir);
      spool.write('traces', body('{}'));
      await spool.forceFlush();

      const name = (await readdir(dir)).find(entry => entry.startsWith('manifest-'));
      assert.ok(name, 'a manifest was written');
      const raw = await readFile(join(dir, name), 'utf8');
      const manifest = JSON.parse(raw) as Record<string, unknown>;

      assert.equal(manifest.spoolFormatVersion, SPOOL_FORMAT_VERSION);
      assert.equal(manifest.endpoint, MANIFEST.endpoint);
      assert.equal(manifest.contentCapture, 'none');
      assert.ok(!/authorization|bearer|apikey|token|secret/i.test(raw), raw);

      await spool.shutdown();
    });
  });

  it('ties segments to it, so two configurations can share a directory', async () => {
    await withSpoolDir(async dir => {
      const one = spoolIn(dir);
      const two = new Spool(resolveSpoolOptions({ enabled: true, dir }), {
        ...MANIFEST,
        endpoint: 'https://elsewhere.example',
      });
      one.write('traces', body('{"a":1}'));
      two.write('traces', body('{"b":2}'));
      await Promise.all([one.forceFlush(), two.forceFlush()]);

      const manifests = (await readdir(dir)).filter(name => name.startsWith('manifest-'));
      assert.equal(manifests.length, 2, 'one manifest per configuration');

      const ids = (await segments(dir)).map(name => name.split('-').at(-1));
      assert.equal(new Set(ids).size, 2, 'each segment names the manifest it belongs to');

      await one.shutdown();
      await two.shutdown();
    });
  });
});

describe('permissions', () => {
  it('writes 0600 files into a 0700 directory even under a permissive umask', async t => {
    if (typeof process.getuid !== 'function') return t.skip('POSIX only');

    await withSpoolDir(async dir => {
      const previous = process.umask(0o000);
      try {
        const nested = join(dir, 'spool');
        const spool = spoolIn(nested);
        spool.write('traces', body('{"secret":"prompt"}'));
        await spool.forceFlush();

        assert.equal((await lstat(nested)).mode & 0o777, 0o700);
        const [name] = await segments(nested);
        assert.equal((await lstat(join(nested, name!))).mode & 0o777, 0o600);

        await spool.shutdown();
      } finally {
        process.umask(previous);
      }
    });
  });

  it('refuses a group- or world-writable directory rather than putting prompts in it', async t => {
    if (typeof process.getuid !== 'function') return t.skip('POSIX only');

    await withSpoolDir(async dir => {
      const open = join(dir, 'open');
      await mkdir(open, { mode: 0o777 });
      /** mkdir's mode is masked by umask; say it again so the case is real. */
      const { chmod } = await import('node:fs/promises');
      await chmod(open, 0o777);

      const spool = spoolIn(open);
      spool.write('traces', body('{}'));
      await spool.forceFlush();

      assert.deepEqual(await segments(open), []);
      assert.equal(spool.directory, undefined);
      assert.equal(spool.stats().dropped, 1, 'the batch is reported lost, not silently accepted');
      await spool.shutdown();
    });
  });

  it('refuses a symlinked directory, because somebody else picked the destination', async t => {
    if (typeof process.getuid !== 'function') return t.skip('POSIX only');

    await withSpoolDir(async dir => {
      const real = join(dir, 'real');
      const link = join(dir, 'link');
      await mkdir(real, { mode: 0o700 });
      await symlink(real, link);

      const spool = spoolIn(link);
      spool.write('traces', body('{}'));
      await spool.forceFlush();

      assert.deepEqual(await segments(real), []);
      await spool.shutdown();
    });
  });
});

describe('the bounds', () => {
  it('evicts the oldest segments rather than filling the disk', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir, { maxBytes: 200, onOverflow: 'evict-oldest' });
      for (let index = 0; index < 8; index += 1) {
        spool.write('traces', body(`{"n":${index},"pad":"${'x'.repeat(60)}"}`));
        await spool.forceFlush();
      }

      const names = await segments(dir);
      assert.ok(names.length < 8, `kept ${names.length} segments under a 200-byte cap`);
      assert.ok(spool.stats().evicted > 0);

      /** What survives is the newest, which is the point of evicting the oldest. */
      const last = await readFile(join(dir, names.at(-1)!), 'utf8');
      assert.match(last, /"n":7/);

      await spool.shutdown();
    });
  });

  it('refuses the new batch instead under drop-new', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir, { maxBytes: 120, onOverflow: 'drop-new' });
      spool.write('traces', body(`{"first":"${'x'.repeat(100)}"}`));
      await spool.forceFlush();
      spool.write('traces', body(`{"second":"${'x'.repeat(100)}"}`));
      await spool.forceFlush();

      const names = await segments(dir);
      assert.equal(names.length, 1);
      assert.match(await readFile(join(dir, names[0]!), 'utf8'), /first/);
      assert.equal(spool.stats().dropped, 1);
      assert.equal(spool.stats().evicted, 0);

      await spool.shutdown();
    });
  });

  it('deletes segments older than maxAge, delivered or not', async () => {
    await withSpoolDir(async dir => {
      const stale = join(dir, `traces-1-000001-1-deadbeef${SEGMENT_SUFFIX}`);
      await writeFile(stale, '{"old":true}', { mode: 0o600 });
      const { utimes } = await import('node:fs/promises');
      const longAgo = new Date(Date.now() - 10 * 60 * 1000);
      await utimes(stale, longAgo, longAgo);

      const spool = spoolIn(dir, { maxAgeMs: 60_000 });
      spool.write('traces', body('{"new":true}'));
      await spool.forceFlush();

      const names = await segments(dir);
      assert.ok(!names.some(name => name.includes('deadbeef')), 'the stale segment is gone');
      assert.equal(names.length, 1);
      await spool.shutdown();
    });
  });

  it('bounds memory when the directory never becomes writable', async () => {
    await withSpoolDir(async dir => {
      /** A file where a directory would have to be: mkdir cannot succeed here. */
      const blocked = join(dir, 'a-file');
      await writeFile(blocked, 'not a directory');

      const spool = new Spool(
        resolveSpoolOptions({ enabled: true, dir: join(blocked, 'spool') }),
        MANIFEST,
      );
      for (let index = 0; index < 500; index += 1) spool.write('traces', body(`{"n":${index}}`));
      await spool.forceFlush();

      assert.equal(spool.directory, undefined);
      assert.ok(spool.stats().dropped >= 500 - 128, 'nothing is held once there is nowhere to put it');
      await spool.shutdown();
    });
  });
});

describe('a disabled spool', () => {
  it('accepts nothing and says so, so the caller reports the failure it had', async () => {
    await withSpoolDir(async dir => {
      const spool = new Spool(resolveSpoolOptions({ enabled: false, dir }), MANIFEST);
      assert.equal(spool.write('traces', body('{}')), false);
      await spool.forceFlush();
      assert.deepEqual(await segments(dir), []);
      await spool.shutdown();
    });
  });

  it('stops accepting after shutdown rather than writing during process exit', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir);
      spool.write('traces', body('{"before":true}'));
      await spool.shutdown();

      assert.equal(spool.write('traces', body('{"after":true}')), false);
      await spool.forceFlush();
      assert.equal((await segments(dir)).length, 1);
    });
  });

  it('is only closed by the last holder, so traces and logs cannot cut each other off', async () => {
    await withSpoolDir(async dir => {
      const spool = spoolIn(dir);
      spool.retain();
      spool.retain();

      await spool.release();
      assert.equal(spool.write('traces', body('{"still":"open"}')), true);

      await spool.release();
      assert.equal(spool.write('traces', body('{"closed":true}')), false);
      await spool.forceFlush();

      assert.equal((await segments(dir)).length, 1);
    });
  });
});
