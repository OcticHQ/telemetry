/**
 * Agent receipts and the sealed input.
 *
 * A receipt is a short, structured statement an agent makes about its own run.
 * It is checked against the generated vocabulary (`receipts.gen.ts`), written
 * to the spool directory as a file of its own inside the call, and drained
 * later by Airlock's orchestrator. Nothing here holds a type or key literal.
 *
 * `recordReceipt` and `sealedInput` never throw, and warn once per distinct
 * problem through `process.emitWarning`, not `diag`: `diag` prints nothing
 * unless `OCTIC_TELEMETRY_DEBUG=1`, and these run before or without `init()`.
 */
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';

import {
  MAX_ATTRIBUTE_VALUE_CHARS,
  MAX_RECEIPT_BYTES,
  MAX_RECEIPTS_PER_RUN,
  RECEIPT_SHAPES,
  RECEIPT_TYPES,
  type ReceiptShape,
} from './receipts.gen.ts';
import { newWriterId, sharedDirectory } from './spool.ts';

/** Bumped when the file's shape changes in a way a reader must notice. */
export const RECEIPT_FORMAT_VERSION = 1;

interface Spec {
  required: Record<string, ReceiptShape>;
  optional: Record<string, ReceiptShape>;
}

const COMPILED = new Map<string, RegExp>(
  Object.entries(RECEIPT_SHAPES).map(([name, pattern]) => [name, new RegExp(pattern)]),
);

const writerId = newWriterId();
let seq = 0;
let written = 0;
const warned = new Set<string>();

const warnOnce = (message: string): void => {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(`octic-telemetry: ${message}`);
};

/** The attributes as strings if they fit the vocabulary, else undefined. */
const check = (type: string, attributes: Record<string, string | number>) => {
  if (!Object.hasOwn(RECEIPT_TYPES, type)) return undefined;
  const spec = RECEIPT_TYPES[type as keyof typeof RECEIPT_TYPES] as Spec;
  const checked: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    const shape = Object.hasOwn(spec.required, key)
      ? spec.required[key]
      : Object.hasOwn(spec.optional, key)
        ? spec.optional[key]
        : undefined;
    if (shape === undefined) return undefined;
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isSafeInteger(value))) {
      return undefined;
    }
    const text = String(value);
    // UTF-16 units, not code points: every shape is ASCII, so the two agree on anything a shape admits.
    if (text.length > MAX_ATTRIBUTE_VALUE_CHARS) return undefined;
    if (COMPILED.get(shape)?.test(text) !== true) return undefined;
    checked[key] = text;
  }
  if (Object.keys(spec.required).some(key => !Object.hasOwn(checked, key))) return undefined;
  return checked;
};

/** Writes one receipt file and says whether it landed. Never throws. */
export function recordReceipt(type: string, attributes: Record<string, string | number>): boolean {
  try {
    const checked = check(type, attributes);
    if (checked === undefined) {
      warnOnce(`receipt ${JSON.stringify(type)} is not on the vocabulary; not recorded`);
      return false;
    }
    const body = Buffer.from(
      JSON.stringify({
        receiptFormatVersion: RECEIPT_FORMAT_VERSION,
        type,
        attributes: checked,
        occurredAt: new Date().toISOString(),
      }),
    );
    if (body.length > MAX_RECEIPT_BYTES) {
      warnOnce(`receipt ${JSON.stringify(type)} is over ${MAX_RECEIPT_BYTES} bytes; not recorded`);
      return false;
    }
    if (written >= MAX_RECEIPTS_PER_RUN) {
      warnOnce(`already recorded ${MAX_RECEIPTS_PER_RUN} receipts; not recording more`);
      return false;
    }
    const dir = sharedDirectory();
    if (dir === undefined) {
      warnOnce('no usable spool directory; receipt not recorded');
      return false;
    }
    seq += 1;
    const final = join(
      dir,
      `receipt-${Date.now()}-${String(seq).padStart(6, '0')}-${writerId}.json`,
    );
    const tmp = `${final}.tmp`;
    try {
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeSync(fd, body);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, final);
    } catch {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean up */
      }
      warnOnce('could not write the receipt file');
      return false;
    }
    written += 1;
    return true;
  } catch {
    warnOnce('recording a receipt failed unexpectedly');
    return false;
  }
}

/**
 * The run's sealed input from the gate, or null. Never rejects. Only a
 * data-blind run has one: `AIRLOCK_RUN_MODE` must be `data_blind`.
 */
export function sealedInput(): Promise<Uint8Array | null> {
  if (process.env.AIRLOCK_RUN_MODE !== 'data_blind') return Promise.resolve(null);
  const socketPath = process.env.AIRLOCK_GATE_SOCKET;
  if (socketPath === undefined || socketPath === '') {
    warnOnce('AIRLOCK_GATE_SOCKET is not set; no sealed input');
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    const fail = (): void => {
      warnOnce('could not read the sealed input from the gate');
      resolve(null);
    };
    try {
      const req = request({ socketPath, path: '/v0/data/sealed', method: 'GET', timeout: 30_000 });
      req.on('timeout', () => req.destroy());
      req.on('error', fail);
      req.on('response', res => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', fail);
        res.on('end', () => {
          if (res.statusCode === 200) resolve(new Uint8Array(Buffer.concat(chunks)));
          else fail();
        });
      });
      req.end();
    } catch {
      fail();
    }
  });
}

/** For tests: forget the count and the one-time warnings. */
export const resetReceiptsForTests = (): void => {
  seq = 0;
  written = 0;
  warned.clear();
};
