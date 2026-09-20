import { GatewayError, abortError } from './errors.mjs';

export class BoundedQueue {
  constructor({ maxPending = 8 } = {}) {
    this.maxPending = maxPending;
    this.active = 0;
    this.pending = [];
  }

  get stats() {
    return { active: this.active, pending: this.pending.length, capacity: this.maxPending };
  }

  run(task, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active > 0 && this.pending.length >= this.maxPending) {
      return Promise.reject(
        new GatewayError('queue_full', 'The private Codex gateway queue is full.', 503),
      );
    }
    return new Promise((resolve, reject) => {
      const entry = { task, signal, resolve, reject, onAbort: null };
      entry.onAbort = () => {
        const index = this.pending.indexOf(entry);
        if (index !== -1) {
          this.pending.splice(index, 1);
          reject(abortError(signal));
        }
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.pending.push(entry);
      this.#drain();
    });
  }

  #drain() {
    if (this.active > 0) return;
    const entry = this.pending.shift();
    if (!entry) return;
    entry.signal?.removeEventListener('abort', entry.onAbort);
    if (entry.signal?.aborted) {
      entry.reject(abortError(entry.signal));
      queueMicrotask(() => this.#drain());
      return;
    }
    this.active = 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.active = 0;
        this.#drain();
      });
  }
}
