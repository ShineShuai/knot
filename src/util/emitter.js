// Minimal event emitter. `on` returns an unsubscribe function.
export class Emitter {
  #handlers = new Map();

  on(event, fn) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(fn);
    return () => this.#handlers.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    for (const fn of [...(this.#handlers.get(event) ?? [])]) {
      try { fn(...args); } catch (err) { console.error(`handler for "${event}" failed`, err); }
    }
  }
}
