/**
 * FIFO queue with concurrency 1. The device's httpd is single-threaded, so every call to one device goes
 * through one of these. `depth` (waiting + running) feeds the "device busy" indicator.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private count = 0;

  constructor(private readonly onChange?: (depth: number) => void) {}

  get depth(): number {
    return this.count;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.count++;
    this.onChange?.(this.count);
    const done = (): void => {
      this.count--;
      this.onChange?.(this.count);
    };
    const result = this.tail.then(task, task);
    this.tail = result.then(done, done);
    return result;
  }
}
