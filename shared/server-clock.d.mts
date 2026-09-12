export function createServerClock(monotonicNow?: () => number, wallNow?: () => number): {
  sync(value: number | undefined): void
  now(): number
}
