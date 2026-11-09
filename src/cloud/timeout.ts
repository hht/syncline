/**
 * Awaits work and rejects with message if it does not finish within ms milliseconds.
 *
 * When an external destination stops responding (such as a stalled exporter or broadcast shard),
 * this finishes and allows rescheduling with backoff rather than stalling until terminated by
 * platform wall-clock limits. Unfinished work cannot be cancelled, but is no longer awaited.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string) {
  const { promise: expired, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms));
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
