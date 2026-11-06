import { describe, expect, it } from 'vitest'
import { addQuota, nextQuotaReset, quotaDayKey, remainingUploads } from './quota'

describe('quota (Pacific day)', () => {
  it('uses the Pacific calendar day, not UTC', () => {
    // 2025-03-01T06:30Z is still 2025-02-28 22:30 in Los Angeles (PST)
    expect(quotaDayKey(new Date('2025-03-01T06:30:00Z'))).toBe('2025-02-28')
    expect(quotaDayKey(new Date('2025-03-01T08:30:00Z'))).toBe('2025-03-01')
  })
  it('nextQuotaReset lands on the first minute of the next Pacific day', () => {
    const now = new Date('2025-03-01T06:30:00Z')
    const reset = nextQuotaReset(now)
    expect(quotaDayKey(reset)).toBe('2025-03-01')
    expect(quotaDayKey(new Date(reset.getTime() - 60_000))).toBe('2025-02-28')
  })
  it('remainingUploads resets when the day changes', () => {
    const d1 = new Date('2025-03-01T07:00:00Z'), d2 = new Date('2025-03-01T09:00:00Z')
    expect(remainingUploads({ day: quotaDayKey(d1), uploads: 6, units: 0 }, 6, 10_000, d1)).toBe(0)
    expect(remainingUploads({ day: quotaDayKey(d1), uploads: 6, units: 0 }, 6, 10_000, d2)).toBe(6)
  })
  it('units budget also caps uploads (thumbnail + playlist adds eat into it)', () => {
    const now = new Date('2025-03-01T09:00:00Z')
    const q = { day: quotaDayKey(now), uploads: 0, units: 0 }
    addQuota(q, { uploads: 5, units: 5 * (1600 + 50 + 100) }, now)   // 5 uploads with thumbnail + 2 playlists each = 8,750
    expect(q.units).toBe(8750)
    expect(remainingUploads(q, 6, 10_000, now)).toBe(0)                  // 1,250 left < 1,600 → no more uploads
    expect(remainingUploads(q, 6, 20_000, now)).toBe(1)                  // raised quota → the count cap applies
    expect(remainingUploads({ day: 'old', uploads: 9, units: 99_999 }, 6, 10_000, now)).toBe(6)  // new day resets
  })
})
