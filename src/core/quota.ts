/** YouTube Data API quota resets at midnight Pacific Time, not UTC. */
export const QUOTA_TZ = 'America/Los_Angeles'
export const UPLOAD_COST_UNITS = 1600
export const THUMBNAIL_COST_UNITS = 50
export const PLAYLIST_ADD_COST_UNITS = 50
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

export interface QuotaState { day: string; uploads: number; units: number }

export function normaliseQuota(state: QuotaState | null | undefined, now: Date = new Date()): QuotaState {
  const day = quotaDayKey(now)
  if (state && state.day === day) return { day, uploads: state.uploads ?? 0, units: state.units ?? 0 }
  return { day, uploads: 0, units: 0 }
}

/** Uploads still possible today: bounded by the user's upload cap AND by the API unit budget
 *  (an upload needs 1,600 units; thumbnail + playlist adds come out of the same budget). */
export function remainingUploads(state: QuotaState | null | undefined, dailyLimit: number, dailyUnits: number = DEFAULT_DAILY_UNITS, now: Date = new Date()): number {
  const q = normaliseQuota(state, now)
  const byCount = dailyLimit - q.uploads
  const byUnits = Math.floor((dailyUnits - q.units) / UPLOAD_COST_UNITS)
  return Math.max(0, Math.min(byCount, byUnits))
}

/** Mutate a quota state in place for today, adding uploads/units. */
export function addQuota(q: QuotaState, add: { uploads?: number; units?: number }, now: Date = new Date()): void {
  const n = normaliseQuota(q, now)
  q.day = n.day; q.uploads = n.uploads + (add.uploads ?? 0); q.units = n.units + (add.units ?? 0)
}
