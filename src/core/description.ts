import type { Parsed } from '@shared/types'
import { PRAYER_AR } from './prayers'
import { DEFAULT_SURAHS, translateSurah, type SurahDict } from './surahs'

/** "٦ شعبان ١٤٤٦ هـ" for a filename date DD.MM.YYYY (Umm al-Qura, Arabic-Indic digits, same as the thumbnail). */
export function hijriDate(ddmmyyyy: string): string {
  const [d, m, y] = ddmmyyyy.split('.').map(Number)
  if (!d || !m || !y) return ddmmyyyy
  const date = new Date(Date.UTC(y, m - 1, d, 12))
  const s = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date)
  return `${s.replace(/\s*هـ\s*$/, '')} هـ`
}

export interface DescriptionInput {
  title: string
  reciterAr: string
  sheikhPrefix: boolean
  parsed: Parsed
  /** the global text from Settings → Upload defaults, appended last */
  extra?: string
}

/**
 * The video description: the title again, then what the thumbnail shows (reciter, surah, prayer · Hijri
 * date), then the user's default description text.
 */
export function buildDescription(input: DescriptionInput, dict: SurahDict = DEFAULT_SURAHS): string {
  const { title, reciterAr, sheikhPrefix, parsed } = input
  const surahs = parsed.surahs.map((s) => translateSurah(s, dict)).join(' و ')
  const prayer = PRAYER_AR[parsed.prayer] ?? parsed.prayer
  const name = sheikhPrefix && !/^الشيخ\s/.test(reciterAr.trim()) ? `الشيخ ${reciterAr.trim()}` : reciterAr.trim()
  const lines = [title, '', name, `سورة ${surahs}`, `صلاة ${prayer} · ${hijriDate(parsed.date)}`]
  const extra = input.extra?.trim()
  if (extra) lines.push('', extra)
  return lines.join('\n')
}
