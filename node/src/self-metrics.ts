/**
 * A `MeterProvider` that exists to read one number back out of OpenTelemetry.
 *
 * The batch processors bound their queues and drop what does not fit. That drop
 * is the failure this SDK exists to remove — telemetry disappearing with
 * nothing to show for it — so it has to reach `counters.ts` alongside every
 * other drop the pipeline counts. There is no getter for it: the processor
 * reports internally to `SpanProcessorMetrics` /`LogRecordProcessorMetrics`,
 * which write to whatever meter `selfObsMeterProvider` hands them and to
 * nothing else (`sdk-trace/build/src/export/SpanProcessorMetrics.js:47-49`,
 * `sdk-logs/build/src/export/LogRecordProcessorMetrics.js:24-30`). The private
 * `_droppedSpansCount` field is reset to zero every time the warning is
 * emitted, so reading it is both unsupported and wrong.
 *
 * So: supply a meter. It is not a metrics pipeline and must not become one —
 * nothing here aggregates, exports, or keeps a time series, and no measurement
 * leaves the process. Every instrument is a sink except the one counter whose
 * `error.type: 'queue_full'` writes we forward. That is why this is ~90 lines
 * of no-ops against `@opentelemetry/api` rather than a dependency on
 * `@opentelemetry/sdk-metrics`.
 */
import type {
  Attributes,
  BatchObservableCallback,
  Counter,
  Gauge,
  Histogram,
  Meter,
  MeterProvider,
  Observable,
  ObservableCallback,
  ObservableCounter,
  ObservableGauge,
  ObservableUpDownCounter,
  UpDownCounter,
} from '@opentelemetry/api';
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';
import { count } from './counters.ts';

/**
 * The value the processors tag a queue-overflow drop with. Their own constant
 * is not exported from either package's public entry point, so it is restated
 * here — and pinned by a test that drives a real processor into overflow rather
 * than by trust, because a rename upstream would silently stop the counting and
 * look exactly like a pipeline that never overflowed.
 */
export const QUEUE_FULL = 'queue_full';

const noopObservable = <T extends Attributes>(): Observable<T> => ({
  addCallback: (_callback: ObservableCallback<T>) => undefined,
  removeCallback: (_callback: ObservableCallback<T>) => undefined,
});

/**
 * `onDrop` is called with the number of records the processor gave up on, as it
 * gives up on them. Counts, never rates: the caller decides what to do with it.
 */
export const droppedRecordMeterProvider = (onDrop: (count: number) => void): MeterProvider => {
  const counter = <T extends Attributes>(): Counter<T> => ({
    add: (value: number, attributes?: T) => {
      if (attributes?.[ATTR_ERROR_TYPE] !== QUEUE_FULL) return;
      onDrop(value);
    },
  });

  const upDownCounter = <T extends Attributes>(): UpDownCounter<T> => ({
    add: () => undefined,
  });

  const meter: Meter = {
    createCounter: counter,
    createUpDownCounter: upDownCounter,
    createGauge: <T extends Attributes>(): Gauge<T> => ({ record: () => undefined }),
    createHistogram: <T extends Attributes>(): Histogram<T> => ({ record: () => undefined }),
    createObservableCounter: <T extends Attributes>(): ObservableCounter<T> => noopObservable<T>(),
    createObservableGauge: <T extends Attributes>(): ObservableGauge<T> => noopObservable<T>(),
    createObservableUpDownCounter: <T extends Attributes>(): ObservableUpDownCounter<T> =>
      noopObservable<T>(),
    /**
     * The queue-size gauge registers a callback here that closes over the live
     * processor. Never invoking it is the point — an observable is only read
     * during a collection cycle, and there is no collection cycle.
     */
    addBatchObservableCallback: <T extends Attributes>(
      _callback: BatchObservableCallback<T>,
      _observables: Observable<T>[],
    ) => undefined,
    removeBatchObservableCallback: <T extends Attributes>(
      _callback: BatchObservableCallback<T>,
      _observables: Observable<T>[],
    ) => undefined,
  };

  return { getMeter: () => meter };
};

/**
 * What both batch processors are given. One counter for both signals: a full
 * queue is a full queue, and splitting the number by signal would invite the
 * reading that one of them is fine.
 */
export const queueDropMeterProvider = (): MeterProvider =>
  droppedRecordMeterProvider(dropped => {
    count('queueDropped', dropped);
  });
