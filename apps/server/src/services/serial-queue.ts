/**
 * Minimal per-key serial queue. For each key, at most one task runs at a time;
 * additional `enqueue()` calls for the same key queue up in FIFO order.
 * Used by ObservationService to serialize LLM extraction per session without
 * blocking extraction for a different session.
 */
export class SerialQueue<K> {
  private tails: Map<K, Promise<unknown>> = new Map();
  private depths: Map<K, number> = new Map();

  enqueue<T>(key: K, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    this.depths.set(key, (this.depths.get(key) ?? 0) + 1);

    const next = previous.then(() => task());
    // Swallow rejections on the chain so subsequent tasks still run; callers
    // that want to observe errors must await their own enqueue() return value.
    const quiet = next.catch(() => undefined);
    this.tails.set(key, quiet);

    quiet.finally(() => {
      const depth = (this.depths.get(key) ?? 1) - 1;
      if (depth <= 0) {
        this.depths.delete(key);
        if (this.tails.get(key) === quiet) this.tails.delete(key);
      } else {
        this.depths.set(key, depth);
      }
    });

    return next;
  }

  depth(key: K): number {
    return this.depths.get(key) ?? 0;
  }
}
