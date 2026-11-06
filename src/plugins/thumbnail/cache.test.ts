import { describe, expect, it } from 'vitest'
import { cacheKey } from './cache'
import type { ThumbnailJob } from './types'

const job: ThumbnailJob = {
  reciterNameAr: 'عبدالله الموسى', photoPath: '/lib/A/photo.jpg', surahsAr: ['يوسف'], prayer: 'Fajr', date: '2025-02-05',
  options: { sheikhPrefix: true, template: 'default' },
}
const photo = { size: 1000, mtimeMs: 1700000000000 }

describe('cacheKey', () => {
  it('is stable for the same job', () => { expect(cacheKey(job, 1, photo)).toBe(cacheKey({ ...job }, 1, photo)) })
  it('changes when anything that affects the picture changes', () => {
    const base = cacheKey(job, 1, photo)
    expect(cacheKey(job, 2, photo)).not.toBe(base)
    expect(cacheKey(job, 1, { ...photo, mtimeMs: photo.mtimeMs + 5000 })).not.toBe(base)
    expect(cacheKey({ ...job, date: '2025-02-06' }, 1, photo)).not.toBe(base)
    expect(cacheKey({ ...job, surahsAr: ['يوسف', 'الكهف'] }, 1, photo)).not.toBe(base)
    expect(cacheKey({ ...job, options: { ...job.options, sheikhPrefix: false } }, 1, photo)).not.toBe(base)
  })
  it('ignores whitespace around the name', () => { expect(cacheKey({ ...job, reciterNameAr: ' عبدالله الموسى ' }, 1, photo)).toBe(cacheKey(job, 1, photo)) })
})
