/**
 * Pure job logic: validation, Hijri date, prayer wording, surah → number.
 * No Electron, no app imports — unit-tested under plain Node.
 */
import { SURAHS_AR } from './surahs'
import type { ThumbnailJob, ThumbnailReason } from './types'

/** Prayer → Arabic. Copied from the app's table on purpose (the plugin imports nothing from the app);
 *  job.test.ts checks the two still agree. */
export const PRAYER_AR: Readonly<Record<string, string>> = {
  Fajr: 'الفجر',
  Maghrib: 'المغرب',
  Isha: 'العشاء',
  Jumuah: 'الجمعة',
  Duha: 'الضحى',
  Taraweeh: 'التراويح',
  Qiyam: 'القيام',
  Tahajjud: 'التهجد',
  Witr: 'الوتر',
  Eid: 'العيد',
  Istisqa: 'الاستسقاء',
  Kusuf: 'الكسوف',
}

export const SHEIKH = 'الشيخ'

/** The hardest content the layout will see: the widest surah pair, the longest prayer, the longest
 *  month name. The sweep renders with it; the app's editor can offer the same preview. */
export const WORST_CASE = {
  reciterNameAr: 'عبد الرحمن بن عبد العزيز السديس',
  surahsAr: ['الكافرون', 'العاديات'],
  prayer: 'Istisqa',
  date: '2024-12-31',
} as const

/** What the HTML template consumes. */
export interface TemplateData {
  photo: string            // file:// URL
  surahs: number[]         // 1–114
  reciter_name: string
  prayer: string           // "صلاة العشاء"
  date: string             // "١ رمضان ١٤٤٦ هـ"
  /** @font-face block for the bundled fonts (sent once per window). */
  bundledCss?: string
  /** file:// URLs of custom font files per line. */
  customFonts?: Partial<Record<'reciter' | 'meta', string>>
}

export type JobCheck =
  | { ok: true; data: Omit<TemplateData, 'photo'> }
  | { ok: false; reason: ThumbnailReason; message: string }

// ── Arabic normalisation ─────────────────────────────────────────────────────

/** Loose comparison key: no diacritics or tatweel, alef/ya variants unified, spaces collapsed, optional «سورة» dropped. */
export function normaliseArabic(s: string): string {
  return s
    .replace(/[ً-ْٰـ]/g, '')     // tashkeel, superscript alef, tatweel
    .replace(/[آأإ]/g, 'ا')      // آ أ إ → ا
    .replace(/ى/g, 'ي')                    // ى → ي
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^سورة\s+/, '')
}

const BY_KEY: ReadonlyMap<string, number> = new Map(SURAHS_AR.map((n, i) => [normaliseArabic(n), i + 1]))

/** Surah number (1–114) for an Arabic name, or null when it is not one of the 114. */
export function surahNumber(nameAr: string): number | null {
  return BY_KEY.get(normaliseArabic(nameAr)) ?? null
}

// ── Dates ────────────────────────────────────────────────────────────────────

const HIJRI = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
})

/** "YYYY-MM-DD" → a UTC-noon Date, or null if it is not a real calendar date. */
export function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  const date = new Date(Date.UTC(y, mo - 1, d, 12))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null
  return date
}

/** Umm al-Qura Hijri date with Arabic-Indic digits, e.g. "١ رمضان ١٤٤٦ هـ". No day adjustment. */
export function hijriDate(iso: string): string | null {
  const d = parseIsoDate(iso)
  return d ? HIJRI.format(d) : null
}

// ── Validation ───────────────────────────────────────────────────────────────

const fail = (reason: ThumbnailReason, message: string): JobCheck => ({ ok: false, reason, message })

/** Check a job and compute everything the template needs except the photo URL. */
export function checkJob(job: ThumbnailJob): JobCheck {
  if (!job || typeof job !== 'object') return fail('INVALID_JOB', 'Job is not an object.')
  const name = (job.reciterNameAr ?? '').trim()
  if (!name) return fail('INVALID_JOB', 'Reciter Arabic name is empty.')
  if (!job.photoPath) return fail('INVALID_JOB', 'Photo path is empty.')
  if (!Array.isArray(job.surahsAr) || job.surahsAr.length === 0) return fail('INVALID_JOB', 'At least one surah is required.')
  if (job.options?.template !== 'default') return fail('INVALID_JOB', `Unknown template "${String(job.options?.template)}".`)

  const surahs: number[] = []
  for (const s of job.surahsAr) {
    const n = surahNumber(s)
    if (!n) return fail('UNKNOWN_SURAH', `Surah «${s}» is not one of the 114 names the thumbnail font knows — check its Arabic spelling in Surahs.`)
    surahs.push(n)
  }

  const prayerAr = PRAYER_AR[job.prayer]
  if (!prayerAr) return fail('UNKNOWN_PRAYER', `Prayer "${job.prayer}" has no Arabic wording in the thumbnail plugin.`)

  const date = hijriDate(job.date)
  if (!date) return fail('BAD_DATE', `Date "${job.date}" is not a valid YYYY-MM-DD date.`)

  return {
    ok: true,
    data: {
      surahs,
      reciter_name: job.options.sheikhPrefix ? `${SHEIKH} ${name}` : name,
      prayer: `صلاة ${prayerAr}`,
      date,
    },
  }
}
