import type { Logger } from 'pino';

/**
 * Structured per-method trace emitted by the SessionDao facade.
 * Every record is one JSON line — greppable, jq-able, and stable.
 *
 * Used for debugging cache-stampede, layer misses, and the Shopify library's invocation patterns
 * during OAuth install / request / uninstall flows.
 */
export interface TraceRecord {
  method:
    | 'storeSession'
    | 'loadSession'
    | 'deleteSession'
    | 'deleteSessions'
    | 'findSessionsByShop';
  sessionId?: string;
  sessionIds?: string[];
  shop?: string;
  isOnline?: boolean;
  /** Which layer ultimately served this call: 'lru' | 'redis' | 'postgres' | 'miss'. */
  layerHit?: 'lru' | 'redis' | 'postgres' | 'miss' | 'write-through' | 'delete-all';
  durationMs: number;
  ok: boolean;
  err?: string;
}

export class LifecycleTracer {
  constructor(private readonly log: Logger) {}

  emit(r: TraceRecord): void {
    const level = r.ok ? 'debug' : 'warn';
    this.log[level]({ dao: 'session', ...r }, 'session-dao-call');
  }

  /** Convenience helper to time an async block and emit a trace. */
  async trace<T>(
    fields: Omit<TraceRecord, 'durationMs' | 'ok' | 'err'>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.emit({ ...fields, durationMs: Math.round(performance.now() - start), ok: true });
      return result;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.emit({
        ...fields,
        durationMs: Math.round(performance.now() - start),
        ok: false,
        err: errMsg,
      });
      throw err;
    }
  }
}
