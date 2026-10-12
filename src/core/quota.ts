/** YouTube Data API quota resets at midnight Pacific Time, not UTC. */
export const QUOTA_TZ = 'America/Los_Angeles'
export const UPLOAD_COST_UNITS = 1600
export const DEFAULT_DAILY_UNITS = 10_000

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: QUOTA_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
})

/** 'YYYY-MM-DD' in Pacific time for the given instant. */
export function quotaDayKey(now: Date = new Date()): string {
  return dayFmt.format(now)
}

/** Instant of the next midnight in Pacific time. */
export function nextQuotaReset(now: Date = new Date()): Date {
  const key = quotaDayKey(now)
  // Walk forward in 15-minute steps until the Pacific day changes, then back off to the minute.
  let t = new Date(now.getTime())
  while (quotaDayKey(t) === key) t = new Date(t.getTime() + 15 * 60_000)
  let lo = new Date(t.getTime() - 15 * 60_000)
  while (t.getTime() - lo.getTime() > 60_000) {
    const mid = new Date((lo.getTime() + t.getTime()) / 2)
    if (quotaDayKey(mid) === key) lo = mid; else t = mid
  }
  t.setSeconds(0, 0)
  return t
}

export interface QuotaState { day: string; uploads: number }

export function normaliseQuota(state: QuotaState | null | undefined, now: Date = new Date()): QuotaState {
  const day = quotaDayKey(now)
  return state && state.day === day ? state : { day, uploads: 0 }
}

export function remainingUploads(state: QuotaState | null | undefined, dailyLimit: number, now: Date = new Date()): number {
  return Math.max(0, dailyLimit - normaliseQuota(state, now).uploads)
}
