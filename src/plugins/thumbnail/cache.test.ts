import { describe, expect, it } from 'vitest'
import { cacheKey } from './cache'
import { canonicalStyle, validateStyle } from './style'
import type { ThumbnailJob } from './types'

const job: ThumbnailJob = {
  reciterNameAr: 'عبدالله الموسى', photoPath: '/lib/A/photo.jpg', surahsAr: ['يوسف'], prayer: 'Fajr', date: '2025-02-05',
  options: { sheikhPrefix: true, template: 'default' },
}
const photo = { size: 1000, mtimeMs: 1700000000000 }
const styleOf = (patch: unknown) => { const r = validateStyle(patch); if (!r.ok) throw new Error('bad style'); return canonicalStyle(r.style) }
const DEF = styleOf({})

describe('cacheKey', () => {
  it('is stable for the same job', () => { expect(cacheKey(job, 1, photo, DEF)).toBe(cacheKey({ ...job }, 1, photo, DEF)) })
  it('changes when anything that affects the picture changes', () => {
    const base = cacheKey(job, 1, photo, DEF)
    expect(cacheKey(job, 2, photo, DEF)).not.toBe(base)
    expect(cacheKey(job, 1, { ...photo, mtimeMs: photo.mtimeMs + 5000 }, DEF)).not.toBe(base)
    expect(cacheKey({ ...job, date: '2025-02-06' }, 1, photo, DEF)).not.toBe(base)
    expect(cacheKey({ ...job, surahsAr: ['يوسف', 'الكهف'] }, 1, photo, DEF)).not.toBe(base)
    expect(cacheKey({ ...job, options: { ...job.options, sheikhPrefix: false } }, 1, photo, DEF)).not.toBe(base)
    expect(cacheKey(job, 1, photo, styleOf({ title: { scale: 0.9 } }))).not.toBe(base)
  })
  it('ignores whitespace around the name', () => { expect(cacheKey({ ...job, reciterNameAr: ' عبدالله الموسى ' }, 1, photo, DEF)).toBe(cacheKey(job, 1, photo, DEF)) })
  it('ignores style key order and explicit defaults', () => {
    expect(styleOf({ title: { scale: 1 }, photo: { blur: 0 } })).toBe(DEF)
    expect(styleOf({ meta: { gap: 0.6 }, title: { scale: 0.9 } })).toBe(styleOf({ title: { scale: 0.9 }, meta: { gap: 0.6 } }))
  })
})
