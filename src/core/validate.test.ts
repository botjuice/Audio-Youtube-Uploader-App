import { describe, expect, it } from 'vitest'
import { buildVocabulary } from './parse'
import { validateToken } from './validate'

const V = buildVocabulary([{ folder: 'Abdullah Al Mousa', aliases: ['Mousa'] }], undefined, ['final', 'finalpart'])

describe('validateToken', () => {
  it('refuses prayers, surahs, dates, reciter clashes, too short', () => {
    expect(validateToken('keyword', 'Isha', V).ok).toBe(false)
    expect(validateToken('keyword', 'baqarah', V).error).toMatch(/surah/)
    expect(validateToken('keyword', '01.03.2025', V).error).toMatch(/date/)
    expect(validateToken('keyword', 'Mousa', V).error).toMatch(/reciter/)
    expect(validateToken('keyword', 'x', V).ok).toBe(false)
  })
  it('refuses duplicates, warns on overlaps, accepts clean ones', () => {
    expect(validateToken('keyword', 'FINAL', V).error).toBe('Already exists')
    expect(validateToken('keyword', 'fin', V).warning).toMatch(/Overlaps/)
    expect(validateToken('keyword', 'olayan', V)).toEqual({ ok: true, key: 'olayan' })
  })
  it('reciter names cannot clash with keywords', () => {
    expect(validateToken('reciter', 'Final', V).error).toMatch(/keyword/)
    expect(validateToken('reciter', 'Mishary', V).ok).toBe(true)
  })
})
