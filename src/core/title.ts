import type { Parsed } from '@shared/types'
import { PRAYER_AR } from './prayers'
import { DEFAULT_SURAHS, translateSurah, type SurahDict } from './surahs'

/** "عبدالله الموسى | سورة الأحزاب و المنافقون - صلاة العشاء 01.03.2025" */
export function buildTitle(reciterAr: string, parsed: Parsed, dict: SurahDict = DEFAULT_SURAHS): string {
  const surahs = parsed.surahs.map((s) => translateSurah(s, dict)).join(' و ')
  const prayer = PRAYER_AR[parsed.prayer] ?? parsed.prayer
  return `${reciterAr} | سورة ${surahs} - صلاة ${prayer} ${parsed.date}`
}
