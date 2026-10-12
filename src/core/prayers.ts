export const PRAYER_AR: Readonly<Record<string, string>> = {
  Fajr: 'الفجر',
  Dhuhr: 'الظهر',
  Asr: 'العصر',
  Maghrib: 'المغرب',
  Isha: 'العشاء',
  Taraweeh: 'التراويح',
  Qiyam: 'القيام',
  Tahajjud: 'التهجد',
  Witr: 'الوتر',
}

export const PRAYERS: readonly string[] = Object.keys(PRAYER_AR)

const LOWER: Readonly<Record<string, string>> = Object.fromEntries(
  PRAYERS.map((p) => [p.toLowerCase(), p]),
)

/** Case-insensitive lookup → canonical prayer name, or null. */
export function canonicalPrayer(raw: string): string | null {
  return LOWER[raw.toLowerCase()] ?? null
}

export const PRAYERS_ALTERNATION = PRAYERS.join('|')
