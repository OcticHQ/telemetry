/**
 * The on-disk spool: where telemetry goes when it cannot be delivered.
 *
 * Three situations, all of them expected in a consumer's environment, end with
 * the SDK holding data it cannot send: no credential (`auth: 'none'` pointed at
 * a forwarder that is not up, or a consumer who does not want to hold a token),
 * a token exchange that fails or expires — OTLP exporter headers are fixed at
 * construction, so a short-TTL JWT 401s forever with no code path to renew it —
 * and ingest being down after the exporter's own retries. Until this file, all
 * three ended the same way: `SimpleSpanProcessor` threw, the global error
 * handler logged, and the spans were gone.
 *
 * A separate process reads this directory and delivers the batches. That
 * process is not in this package, which makes the on-disk shape a contract
 * rather than an implementation detail — it is specified in
 * ../../contract/SPOOL.md and versioned by `SPOOL_FORMAT_VERSION`.
 *
 * Two properties outrank every other consideration here, because this runs
 * inside somebody else's process on their machines:
 *
 *   never hurt the host   no sync I/O on the hot path, no unbounded memory, no
 *                         throw out of a write, no unhandled rejection, and a
 *                         hard self-disable when the filesystem says no
 *   never leak            these files can hold prompts. 0700 directory, 0600
 *                         files, and a directory we refuse to use unless we own
 *                         it and nobody else can write to it
 *
 * Redaction is somebody else's job and already done: the spool sits *inside*
 * `RedactingSpanExporter`, so what reaches it has already been through the
 * content policy. Putting it outside would write raw prompts to a customer's
 * disk under `capture: 'none'`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, writeSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { diag } from '@opentelemetry/api';

/** Bumped when the on-disk shape changes in a way a reader must notice. */
export const SPOOL_FORMAT_VERSION = 1;

/** The suffix a finished batch has. Readers glob for it; `.tmp` is in progress. */
export const SEGMENT_SUFFIX = '.otlp.json';
const TMP_SUFFIX = '.tmp';
const MANIFEST_PREFIX = 'manifest-';

export type SpoolMode = 'fallback' | 'only';
export type SpoolOverflow = 'evict-oldest' | 'drop-new';
export type SpoolSignal = 'traces' | 'logs';

export interface SpoolOptions {
  /**
   * Defaults to true under `mode: 'only'`, the default, or `auth: 'none'` — the
   * arrangements that have no other way to deliver. Under `mode: 'fallback'`
   * with a credential it defaults to false, so the fallback directory is a
   * choice rather than a directory that appears.
   */
  enabled?: boolean;
  /** `only`, the default, never constructs a transport at all; `fallback`
   *  writes only what the transport could not deliver. */
  mode?: SpoolMode;
  /** Else `OCTIC_SPOOL_DIR`, else the cascade in `DEFAULT_DIRECTORIES`. */
  dir?: string;
  /** Bytes of finished segments to keep. Default 64 MiB. */
  maxBytes?: number;
  /** Segments to keep. Default 10,000. */
  maxFiles?: number;
  /** Age at which a segment is deleted unread. Default 72h. */
  maxAgeMs?: number;
  /** What to do when a bound is hit. Default `evict-oldest`. */
  onOverflow?: SpoolOverflow;
  /** `fsync` each segment before the rename. Default true. */
  fsync?: boolean;
}

export interface SpoolConfig {
  enabled: boolean;
  mode: SpoolMode;
  dir?: string;
  maxBytes: number;
  maxFiles: number;
  maxAgeMs: number;
  onOverflow: SpoolOverflow;
  fsync: boolean;
}

export interface SpoolStats {
  /** Segments successfully renamed into place. */
  written: number;
  /** Bytes those segments hold. */
  bytes: number;
  /** Batches the spool refused or discarded before they reached disk. */
  dropped: number;
  /** Finished segments deleted to stay inside the bounds. */
  evicted: number;
  /** Write attempts that failed. */
  failures: number;
  /** Whether the spool has switched itself off. */
  disabled: boolean;
  /** Where it settled, once resolution finishes. */
  dir?: string;
}

/**
 * What a reader needs to deliver these files, and nothing else.
 *
 * Deliberately carries no credential: the reader brings its own. `contentCapture`
 * is here so an operator looking at a directory can tell whether it holds
 * customer prompts without opening one.
 */
export interface SpoolManifest {
  spoolFormatVersion: number;
  endpoint: string;
  signalPaths: Record<SpoolSignal, string>;
  contentType: string;
  contentEncoding: string;
  serviceName: string;
  octicSchemaVersion: string;
  sdkName: string;
  sdkVersion: string;
  contentCapture: string;
  createdAt: string;
}

export type ManifestInput = Omit<SpoolManifest, 'spoolFormatVersion' | 'createdAt'>;

const MIB = 1024 * 1024;

/** Pending batches held while the directory resolves or a write is in flight. */
const MAX_PENDING_BATCHES = 128;
const MAX_PENDING_BYTES = 8 * MIB;

/** Above this we do not attempt the synchronous drain at exit. */
const MAX_EXIT_DRAIN_BYTES = 4 * MIB;

/** How long a filesystem gets to be broken before we probe it again. */
const DISABLE_BACKOFF_MS = 60_000;

/** A reader deletes files behind our back, so the accounting is re-derived. */
const USAGE_RESCAN_MS = 60_000;

/** Errors that mean the filesystem is not going to cooperate any time soon. */
const FATAL_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EDQUOT', 'EMFILE', 'ENFILE']);

export const resolveSpoolOptions = (
  options: SpoolOptions = {},
  { enabledByDefault = false }: { enabledByDefault?: boolean } = {},
): SpoolConfig => ({
  enabled: options.enabled ?? enabledByDefault,
  mode: options.mode ?? 'only',
  ...(options.dir === undefined ? {} : { dir: options.dir }),
  maxBytes: options.maxBytes ?? 64 * MIB,
  maxFiles: options.maxFiles ?? 10_000,
  maxAgeMs: options.maxAgeMs ?? 72 * 60 * 60 * 1000,
  onOverflow: options.onOverflow ?? 'evict-oldest',
  fsync: options.fsync ?? true,
});

/**
 * Where to look, in order, first writable wins.
 *
 * `/var/spool/octic` is the intended home and the one an operator provisions.
 * It is also unwritable for the unprivileged process most consumers run, which
 * is why it is one candidate rather than the answer — a spool that requires
 * root is a spool nobody has.
 */
const defaultDirectories = (): string[] => {
  const candidates: string[] = [];
  const configured = process.env.OCTIC_SPOOL_DIR;
  if (configured !== undefined && configured !== '') candidates.push(configured);

  candidates.push('/var/spool/octic');

  const state = process.env.XDG_STATE_HOME;
  candidates.push(
    state !== undefined && state !== ''
      ? join(state, 'octic', 'spool')
      : join(homedir(), '.local', 'state', 'octic', 'spool'),
  );

  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  candidates.push(join(tmpdir(), `octic-spool-${uid}`));

  return candidates;
};

const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;

/**
 * Whether a directory is one we are willing to put prompts in.
 *
 * The three refusals are the classic ones: a symlink means somebody else chose
 * the real destination, an owner that is not us means somebody else can read
 * it, and a group- or world-writable directory means somebody else can swap
 * files under a reader that trusts them. Windows reports none of this usefully,
 * so the guarantee is POSIX and the cascade ends in the per-user tmpdir there.
 */
const isSafeDirectory = async (dir: string): Promise<boolean> => {
  const info = await lstat(dir);
  if (!info.isDirectory()) return false;
  if (info.isSymbolicLink()) return false;
  if (typeof process.getuid !== 'function') return true;
  if (info.uid !== process.getuid()) return false;
  return (info.mode & 0o022) === 0;
};

export class Spool {
  readonly config: SpoolConfig;

  private readonly manifest: SpoolManifest;
  private readonly manifestId: string;
  /**
   * Who wrote a segment, opaque and unique per instance. The pid alone is not:
   * worker threads share one, and so do two providers in a single process.
   */
  private readonly writerId = `${process.pid}${randomBytes(3).toString('hex')}`;

  private dir: string | undefined;
  private resolving: Promise<string | undefined> | undefined;
  private manifestWritten = false;

  private readonly pending: { signal: SpoolSignal; body: Uint8Array }[] = [];
  private pendingBytes = 0;
  private draining: Promise<void> = Promise.resolve();

  private disabledUntil = 0;
  private shuttingDown = false;
  private owners = 0;
  private seq = 0;
  private announced = false;
  private announcedEviction = false;

  private bytesOnDisk = 0;
  private filesOnDisk = 0;
  private usageScannedAt = 0;

  private written = 0;
  private dropped = 0;
  private evicted = 0;
  private failures = 0;

  private exitDrain: (() => void) | undefined;

  constructor(config: SpoolConfig, manifest: ManifestInput) {
    this.config = config;
    this.manifest = {
      spoolFormatVersion: SPOOL_FORMAT_VERSION,
      ...manifest,
      createdAt: new Date().toISOString(),
    };
    /**
     * The id covers everything except the timestamp, so two processes with the
     * same configuration share a manifest and two with different endpoints
     * cannot have their segments confused for each other.
     */
    const { createdAt: _createdAt, ...identity } = this.manifest;
    this.manifestId = createHash('sha256')
      .update(JSON.stringify(identity))
      .digest('hex')
      .slice(0, 8);
  }

  stats(): SpoolStats {
    return {
      written: this.written,
      bytes: this.bytesOnDisk,
      dropped: this.dropped,
      evicted: this.evicted,
      failures: this.failures,
      disabled: this.isDisabled(),
      ...(this.dir === undefined ? {} : { dir: this.dir }),
    };
  }

  /** Where it settled. Undefined until the cascade has run. */
  get directory(): string | undefined {
    return this.dir;
  }

  private isDisabled(): boolean {
    return this.disabledUntil > Date.now();
  }

  /**
   * Takes custody of one serialized export batch.
   *
   * Returns whether it was accepted, which is what the caller reports upstream:
   * a refusal has to stay a failure, or a consumer whose disk is full is told
   * their telemetry is fine.
   *
   * Never throws, never blocks: the body is queued and the write happens on a
   * chain behind it.
   */
  write(signal: SpoolSignal, body: Uint8Array): boolean {
    if (!this.config.enabled || this.shuttingDown || this.isDisabled()) {
      this.dropped += 1;
      return false;
    }

    /**
     * The memory bound, and the reason it drops the *oldest*: a slow or wedged
     * disk must not turn into heap growth in the host process, and if something
     * has to be lost it should be the batch that has already waited longest.
     */
    this.pending.push({ signal, body });
    this.pendingBytes += body.byteLength;
    while (
      this.pending.length > MAX_PENDING_BATCHES ||
      (this.pendingBytes > MAX_PENDING_BYTES && this.pending.length > 1)
    ) {
      const shed = this.pending.shift();
      if (shed === undefined) break;
      this.pendingBytes -= shed.body.byteLength;
      this.dropped += 1;
    }

    this.schedule();
    return true;
  }

  /** Everything queued is on disk, or was lost trying. Never rejects. */
  forceFlush(): Promise<void> {
    this.schedule();
    return this.draining;
  }

  /**
   * One spool serves both signals, so it cannot close on the first `shutdown()`
   * it hears about: traces and logs live in different providers and shut down
   * independently, and the loser of that race would have its last records
   * refused. Each exporter retains the spool and releases it; the last one out
   * closes the door.
   */
  retain(): void {
    this.owners += 1;
  }

  async release(): Promise<void> {
    this.owners = Math.max(0, this.owners - 1);
    if (this.owners > 0) {
      await this.forceFlush();
      return;
    }
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.shuttingDown = true;
    this.owners = 0;
    if (this.exitDrain !== undefined) {
      process.removeListener('exit', this.exitDrain);
      this.exitDrain = undefined;
    }
  }

  private schedule(): void {
    /**
     * One write in flight at a time, chained rather than parallel: ordering on
     * disk then matches ordering in the process, and a burst cannot open a
     * hundred file descriptors in somebody's server.
     */
    this.draining = this.draining.then(() => this.drainPending()).catch(() => undefined);
  }

  private async drainPending(): Promise<void> {
    if (this.pending.length === 0) return;

    const dir = await this.resolveDir();
    if (dir === undefined) {
      /** No directory means nothing will ever land; do not hold the memory. */
      this.dropped += this.pending.length;
      this.pending.length = 0;
      this.pendingBytes = 0;
      return;
    }

    await this.writeManifest(dir);
    await this.refreshUsage(dir);

    while (this.pending.length > 0) {
      if (this.isDisabled()) {
        this.dropped += this.pending.length;
        this.pending.length = 0;
        this.pendingBytes = 0;
        return;
      }

      const batch = this.pending[0];
      // Unreachable: the loop guard is `this.pending.length > 0`. Written as a
      // narrowing rather than a `!` so `noUncheckedIndexedAccess` stays honest
      // if the guard is ever changed.
      if (batch === undefined) break;
      const admitted = await this.makeRoom(dir, batch.body.byteLength);
      if (!admitted) {
        this.pending.shift();
        this.pendingBytes -= batch.body.byteLength;
        this.dropped += 1;
        continue;
      }

      const ok = await this.writeSegment(dir, batch.signal, batch.body);
      this.pending.shift();
      this.pendingBytes -= batch.body.byteLength;
      if (!ok) this.failures += 1;
    }
  }

  /**
   * The directory cascade, run once, off the init path.
   *
   * Failure to find one is not an error the consumer hears about twice: one
   * `diag.warn`, spooling off, and the application carries on knowing nothing
   * about it.
   */
  private resolveDir(): Promise<string | undefined> {
    if (this.dir !== undefined) return Promise.resolve(this.dir);
    if (this.resolving !== undefined) return this.resolving;

    const candidates = this.config.dir === undefined ? defaultDirectories() : [this.config.dir];

    this.resolving = (async () => {
      for (const candidate of candidates) {
        try {
          await mkdir(candidate, { recursive: true, mode: 0o700 });
          if (!(await isSafeDirectory(candidate))) continue;

          /** mkdir's mode is masked by umask and ignored when the directory
           *  already existed, so set it explicitly either way. */
          if (typeof process.getuid === 'function') await chmod(candidate, 0o700);

          /**
           * Random, not just pid and clock: two processes probing the same
           * directory in the same millisecond would otherwise collide on `wx`
           * and each conclude the directory was unusable.
           */
          const probe = join(candidate, `.probe-${process.pid}-${randomBytes(6).toString('hex')}`);
          const handle = await open(probe, 'wx', 0o600);
          await handle.close();
          await unlink(probe);

          this.dir = candidate;
          this.installExitDrain();
          diag.info(`octic-telemetry: spooling telemetry to ${candidate} (${this.config.mode})`);
          return candidate;
        } catch {
          continue;
        }
      }

      diag.warn(
        `octic-telemetry: no writable spool directory (tried ${candidates.join(', ')}); ` +
          'telemetry that cannot be delivered will be dropped.',
      );
      this.disable();
      return undefined;
    })();

    return this.resolving;
  }

  private disable(): void {
    this.disabledUntil = Date.now() + DISABLE_BACKOFF_MS;
  }

  private noteFatal(error: unknown, what: string): void {
    const code = errnoOf(error);
    if (code !== undefined && FATAL_CODES.has(code)) {
      diag.warn(
        `octic-telemetry: spool ${what} failed with ${code}; pausing for ${DISABLE_BACKOFF_MS / 1000}s.`,
      );
      this.disable();
    }
  }

  private async writeManifest(dir: string): Promise<void> {
    if (this.manifestWritten) return;
    this.manifestWritten = true;

    const path = join(dir, `${MANIFEST_PREFIX}${this.manifestId}.json`);
    try {
      /** `wx`: whoever wrote it first wrote the same bytes. */
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(this.manifest, undefined, 2)}\n`);
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') return;
      this.noteFatal(error, 'manifest write');
    }
  }

  /** `<signal>-<epochMs>-<seq>-<writer>-<manifest>.otlp.json`, per contract/SPOOL.md. */
  private segmentName(signal: SpoolSignal): string {
    this.seq += 1;
    return `${signal}-${Date.now()}-${String(this.seq).padStart(6, '0')}-${this.writerId}-${this.manifestId}${SEGMENT_SUFFIX}`;
  }

  /**
   * Write, then rename. A reader can therefore never see a partial batch: the
   * name it globs for only exists once every byte is on disk, and a crash
   * mid-write leaves a `.tmp` that both sides ignore.
   */
  private async writeSegment(dir: string, signal: SpoolSignal, body: Uint8Array): Promise<boolean> {
    const finalPath = join(dir, this.segmentName(signal));
    const tmpPath = `${finalPath}${TMP_SUFFIX}`;

    try {
      const handle = await open(tmpPath, 'wx', 0o600);
      try {
        /** Explicit, because open's mode is masked by the host's umask. */
        await handle.chmod(0o600);
        await handle.writeFile(body);
        if (this.config.fsync) await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, finalPath);
    } catch (error) {
      this.noteFatal(error, 'segment write');
      await unlink(tmpPath).catch(() => undefined);
      return false;
    }

    this.written += 1;
    this.filesOnDisk += 1;
    this.bytesOnDisk += body.byteLength;

    if (!this.announced) {
      this.announced = true;
      diag.info(`octic-telemetry: first spooled batch written to ${finalPath}`);
    }
    return true;
  }

  /** Finished segments, oldest first. `.tmp` is somebody's in-flight write. */
  private async listSegments(
    dir: string,
  ): Promise<{ path: string; size: number; mtimeMs: number }[]> {
    const names = await readdir(dir);
    const segments: { path: string; size: number; mtimeMs: number }[] = [];

    for (const name of names) {
      if (!name.endsWith(SEGMENT_SUFFIX)) continue;
      const path = join(dir, name);
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        segments.push({ path, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        /** The reader deleted it between readdir and stat. Its job, not ours. */
      }
    }

    segments.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return segments;
  }

  /**
   * Re-derives what is on disk, and drops what has aged out while it is there.
   *
   * The age limit rides along with the scan rather than getting its own pass
   * because the scan is the expensive part, and because an undelivered batch
   * from three days ago is a batch nobody is coming for.
   */
  private async refreshUsage(dir: string): Promise<void> {
    const now = Date.now();
    if (now - this.usageScannedAt < USAGE_RESCAN_MS) return;
    this.usageScannedAt = now;

    try {
      const found = await this.listSegments(dir);
      const cutoff = now - this.config.maxAgeMs;
      const kept: typeof found = [];

      for (const segment of found) {
        if (segment.mtimeMs >= cutoff) {
          kept.push(segment);
          continue;
        }
        try {
          await unlink(segment.path);
          this.evicted += 1;
        } catch {
          kept.push(segment);
        }
      }

      this.filesOnDisk = kept.length;
      this.bytesOnDisk = kept.reduce((total, segment) => total + segment.size, 0);
    } catch (error) {
      this.noteFatal(error, 'usage scan');
    }
  }

  /**
   * Enforces the bounds, and the age limit while it is here.
   *
   * Under `evict-oldest` the reader can lose a file it is mid-way through
   * delivering. That is safe rather than merely tolerable: POSIX keeps an open
   * descriptor valid after unlink, and the format requires the reader to treat
   * a vanished file as done — see contract/SPOOL.md.
   */
  private async makeRoom(dir: string, incoming: number): Promise<boolean> {
    const overBytes = () => this.bytesOnDisk + incoming > this.config.maxBytes;
    const overFiles = () => this.filesOnDisk + 1 > this.config.maxFiles;

    if (!overBytes() && !overFiles()) return true;
    if (this.config.onOverflow === 'drop-new') return false;

    try {
      const segments = await this.listSegments(dir);
      this.filesOnDisk = segments.length;
      this.bytesOnDisk = segments.reduce((total, segment) => total + segment.size, 0);

      for (const segment of segments) {
        if (!overBytes() && !overFiles()) break;
        try {
          await unlink(segment.path);
          this.filesOnDisk -= 1;
          this.bytesOnDisk -= segment.size;
          this.evicted += 1;
        } catch {
          /** Already gone, or not ours to delete. Either way, move on. */
        }
      }

      if (this.evicted > 0 && !this.announcedEviction) {
        this.announcedEviction = true;
        diag.warn(
          `octic-telemetry: spool at ${dir} is full; deleting the oldest undelivered batches. ` +
            'Is the spool reader running?',
        );
      }

      return !(overBytes() || overFiles());
    } catch (error) {
      this.noteFatal(error, 'eviction');
      return false;
    }
  }

  /**
   * The one place a synchronous write is right.
   *
   * `process.on('exit')` cannot await, so anything still queued when the
   * process ends is either written here or lost. Bounded hard, because this
   * runs while the consumer is trying to exit.
   */
  private installExitDrain(): void {
    if (this.exitDrain !== undefined) return;

    this.exitDrain = () => {
      if (this.dir === undefined || this.pending.length === 0) return;
      if (this.pendingBytes > MAX_EXIT_DRAIN_BYTES) return;

      for (const batch of this.pending) {
        const finalPath = join(this.dir, this.segmentName(batch.signal));
        const tmpPath = `${finalPath}${TMP_SUFFIX}`;
        try {
          const fd = openSync(tmpPath, 'wx', 0o600);
          try {
            writeSync(fd, batch.body);
          } finally {
            closeSync(fd);
          }
          renameSync(tmpPath, finalPath);
          this.written += 1;
        } catch {
          /** Exiting anyway; there is nowhere to report this. */
        }
      }
      this.pending.length = 0;
      this.pendingBytes = 0;
    };

    process.on('exit', this.exitDrain);
  }
}
