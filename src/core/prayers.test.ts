import { describe, expect, it } from 'vitest'
import { buildVocabulary, tokenize } from './parse'
import { PRAYERS, canonicalPrayer } from './prayers'

describe('prayers', () => {
  it('list is the aloud prayers; Dhuhr and Asr are gone', () => {
    expect(PRAYERS).toEqual(['Fajr', 'Maghrib', 'Isha', 'Jumuah', 'Duha', 'Taraweeh', 'Qiyam', 'Tahajjud', 'Witr', 'Eid', 'Istisqa', 'Kusuf'])
    expect(canonicalPrayer('Dhuhr')).toBeNull(); expect(canonicalPrayer('asr')).toBeNull()
  })
  it('accepts common spellings', () => {
    for (const [raw, want] of [['jummah', 'Jumuah'], ['Juma', 'Jumuah'], ['dhuha', 'Duha'], ['tarawih', 'Taraweeh'], ['ESHA', 'Isha'], ['khusuf', 'Kusuf'], ['istisqah', 'Istisqa']])
      expect(canonicalPrayer(raw!), raw).toBe(want)
  })
  it('first prayer-looking word is the prayer; later ones are surahs (Jumuah/Duha are both)', () => {
    const v = buildVocabulary([])
    let t = tokenize('JumuahKahf-07.03.2025', v); expect(t.prayer).toBe('Jumuah'); expect(t.surahs.map((s) => s.toLowerCase())).toEqual(['kahf'])
    t = tokenize('IshaDuha-07.03.2025', v); expect(t.prayer).toBe('Isha'); expect(t.surahs.map((s) => s.toLowerCase())).toEqual(['duha'])
    t = tokenize('FajrJumuah-07.03.2025', v); expect(t.prayer).toBe('Fajr'); expect(t.surahs.map((s) => s.toLowerCase())).toEqual(['jumuah'])
  })
  it('aliases never swallow the first letter of the next glued word', () => {
    const t = tokenize('IshaAhzab-01.03.2025', buildVocabulary([]))
    expect(t.prayer).toBe('Isha'); expect(t.surahs.map((s) => s.toLowerCase())).toEqual(['ahzab']); expect(t.leftovers).toEqual([])
  })
  it('a removed prayer word becomes a leftover (NO_PRAYER)', () => {
    const t = tokenize('DhuhrMulk-07.03.2025', buildVocabulary([]))
    expect(t.prayer).toBeNull(); expect(t.leftovers).toEqual(['Dhuhr'])
  })
})
