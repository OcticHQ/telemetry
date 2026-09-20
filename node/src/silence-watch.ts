/**
 * One warning, once, when spans are being produced and none is arriving.
 *
 * The signal has to fire on *silence*, not on error. Every failure this SDK can
 * see already logs — an export that fails, a spool that self-disables, a
 * redaction hook that throws. What none of them covers is the arrangement where
 * nothing is wrong and nothing is flowing: a provider registered too late, a
 * host SDK that got to `setGlobalTracerProvider` first, a loader hook missing
 * so the instrumented library was never patched. Every one of those exits 0
 * having emitted nothing, and a health check that cannot tell "working" from
 * "silent" reproduces the failure it exists to catch.
 *
 * It is a log line rather than an API on purpose. As a `diag.warn` the wording,
 * the delay and the conditions are all free to change; as a field on a
 * structured health object they would be a contract.
 *
 * The timer is `unref()`'d, cleared on the first successful export and cleared
 * on shutdown — this package promises to hold no lifecycle, and a short script
 * that emits one span and returns must not sit here waiting for it to fire.
 */
import { diag } from '@opentelemetry/api';

/**
 * Long enough that a batch delay (5s) plus a retrying export against a slow
 * collector does not trip it, short enough to be visible while somebody is
 * still watching the terminal they started the process in.
 */
export const SILENCE_WARNING_MS = 30_000;

let timer: NodeJS.Timeout | undefined;
let delayMillis = SILENCE_WARNING_MS;
/** Latched: a pipeline that has delivered once is not silent, ever again. */
let delivered = false;

const clear = (): void => {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
};

/**
 * Called by `setup()`. The delay is a parameter only so the tests can drive the
 * real timer instead of asserting on a mock — it is not an `InitOptions` field
 * and should not become one.
 */
export const configureSilenceWatch = (millis: number = SILENCE_WARNING_MS): void => {
  clear();
  delayMillis = millis;
  delivered = false;
};

/**
 * The arming edge, from `OcticSpanProcessor.onStart` — the one hook that
 * runs per span in both entry modes, including the one where a host SDK owns
 * the provider and our processors are all it took from us.
 *
 * First span only. Re-arming per span would push the deadline out forever in
 * any process that keeps producing, which is exactly the process worth warning.
 */
export const noteSpanStarted = (): void => {
  if (delivered || timer !== undefined) return;

  timer = setTimeout(() => {
    timer = undefined;
    diag.warn(
      `octic-telemetry: spans have been produced for ${String(delayMillis)}ms and none has been exported. ` +
        'Common causes: init() ran after the instrumented library was imported, the ' +
        '`--import` loader hook is missing, another SDK registered the global TracerProvider ' +
        'first, or there are two copies of @opentelemetry/api. ' +
        'Run with OCTIC_TELEMETRY_DEBUG=1 and check `npm ls @opentelemetry/api`.',
    );
  }, delayMillis);

  /** Never the reason a process stays alive. */
  timer.unref();
};

/** The disarming edge, from `SafeSpanExporter`'s success path. */
export const noteExportSucceeded = (): void => {
  delivered = true;
  clear();
};

/** From `shutdown()`, alongside everything else this package has to let go of. */
export const cancelSilenceWatch = (): void => {
  clear();
};
