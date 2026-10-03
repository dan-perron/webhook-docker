/**
 * In-memory failed-attempt limiter for the password/token login: after
 * `max` failures from one client within `windowMs`, refuse until the window
 * passes. Single process, single user: memory is enough.
 */
export class FailureLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, list);
    return list;
  }

  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }

  fail(key: string): void {
    this.recent(key).push(this.now());
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}
