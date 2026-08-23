/**
 * What this SDK dropped, failed to send, or swallowed — counted, never exposed.
 *
 * Every guard added for non-interference turns a crash into a return, and a
 * guard that returns quietly is indistinguishable from nothing having gone
 * wrong. These counters are the difference. They are the same numbers a
 * `diagnose()` API would eventually publish, kept internal on purpose: a
 * structured health object is a second product surface, versioned forever, that
 * consumers assert on in their own suites. Maintaining the counts now and
 * shipping the shape later means the eventual API is written against real
 * support tickets rather than a guess made before the first one.
 *
 * Read them today through `OCTIC_TELEMETRY_DEBUG=1`, which turns on the `diag`
 * lines that accompany each increment.
 */

export interface Counters {
  /**
   * Batches the pipeline took custody of — delivered over HTTP *or* accepted by
   * the spool. Not `spansExported`: under `mode: 'only'` nothing is ever
   * exported and a counter reading zero would be read as a broken pipeline.
   */
  spansAccepted: number;
  /** Batches that ended FAILED, after the spool declined or was not there. */
  exportsFailed: number;
  /** Attribute entries the sanitizer refused: wrong type, oversized, over the cap. */
  attributesDropped: number;
  /** Spans dropped from a batch because they could not be copied at all. */
  spansDropped: number;
  /** Throws caught at a processor or exporter callback boundary. */
  processorErrors: number;
  /** `resultCallback` invoked more than once by an inner exporter. */
  duplicateCallbacks: number;
}

const zero = (): Counters => ({
  spansAccepted: 0,
  exportsFailed: 0,
  attributesDropped: 0,
  spansDropped: 0,
  processorErrors: 0,
  duplicateCallbacks: 0,
});

let counters = zero();

export const count = (name: keyof Counters, by = 1): void => {
  counters[name] += by;
};

/** A copy, so nothing outside this module can move a number by holding the object. */
export const snapshot = (): Counters => ({ ...counters });

/**
 * Process state, like the content policy next to it. A test that moves a
 * counter and does not reset it changes what every later test in the same file
 * is asserting about.
 */
export const resetCounters = (): void => {
  counters = zero();
};
