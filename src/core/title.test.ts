import { describe, expect, it } from 'vitest'
import { buildTitle } from './title'

describe('buildTitle', () => {
  it('matches the agreed format', () => {
    expect(buildTitle('عبدالله الموسى', { prayer: 'Isha', surahs: ['Ahzab', 'Munafiqoon'], date: '01.03.2025', reciter: null, keywords: [] }))
      .toBe('عبدالله الموسى | سورة الأحزاب و المنافقون - صلاة العشاء 01.03.2025')
  })
})
