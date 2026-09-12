// Server timestamps establish the epoch; elapsed time uses a monotonic clock,
// so changing the computer's wall clock cannot alter a decision timer.
export const createServerClock = (monotonicNow = () => performance.now(), wallNow = () => Date.now()) => {
  let serverTime = wallNow()
  let receivedAt = monotonicNow()
  return {
    sync(value) {
      if (!Number.isFinite(value)) return
      serverTime = value
      receivedAt = monotonicNow()
    },
    now: () => serverTime + monotonicNow() - receivedAt,
  }
}
