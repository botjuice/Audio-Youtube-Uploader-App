import { describe, expect, it } from 'vitest'
import { nextQuotaReset, quotaDayKey, remainingUploads } from './quota'

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
    expect(remainingUploads({ day: quotaDayKey(d1), uploads: 6 }, 6, d1)).toBe(0)
    expect(remainingUploads({ day: quotaDayKey(d1), uploads: 6 }, 6, d2)).toBe(6)
  })
})
