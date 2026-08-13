interface PendingNext<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

export class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly buffered: T[] = [];
  private readonly pending: PendingNext<T>[] = [];
  private ended = false;
  private failure: unknown;

  constructor(
    private readonly maxBuffered = Number.POSITIVE_INFINITY,
    private readonly coalesce?: (previous: T, next: T) => T | undefined,
  ) {
    if (maxBuffered <= 0) {
      throw new RangeError("AsyncQueue maxBuffered must be positive");
    }
  }

  push(value: T): void {
    if (this.ended) {
      return;
    }

    const waiter = this.pending.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
    } else {
      if (this.buffered.length > 0 && this.coalesce) {
        const previous = this.buffered[this.buffered.length - 1] as T;
        const combined = this.coalesce(previous, value);
        if (combined !== undefined) {
          this.buffered[this.buffered.length - 1] = combined;
          return;
        }
      }
      if (this.buffered.length >= this.maxBuffered) {
        const error = new Error("AsyncQueue buffer limit exceeded");
        this.fail(error);
        throw error;
      }
      this.buffered.push(value);
    }
  }

  close(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    this.resolvePending();
  }

  fail(error: unknown): void {
    if (this.ended) {
      return;
    }
    this.failure = error;
    this.ended = true;
    this.resolvePending();
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffered.length > 0) {
      const value = this.buffered.shift() as T;
      return Promise.resolve({ done: false, value });
    }
    if (this.ended) {
      return this.failure === undefined
        ? Promise.resolve({ done: true, value: undefined })
        : Promise.reject(this.failure);
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  private resolvePending(): void {
    for (const waiter of this.pending.splice(0)) {
      if (this.failure === undefined) {
        waiter.resolve({ done: true, value: undefined });
      } else {
        waiter.reject(this.failure);
      }
    }
  }
}
