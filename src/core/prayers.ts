/** Prayers recited aloud, in filename-dropdown order. Canonical name → Arabic. */
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

export const PRAYERS: readonly string[] = Object.keys(PRAYER_AR)

/** Accepted spellings → canonical name. The canonical name itself is always accepted.
 *  Never add an alias that is a shorter spelling plus extra letters (e.g. "ishaa"): in glued names it would
 *  swallow the first letter of the next word ("IshaAhzab" → "ishaa" + "hzab"). */
const ALIASES: Readonly<Record<string, string[]>> = {
  Fajr: ['fajar'],
  Maghrib: ['magrib', 'maghreb'],
  Isha: ['esha'],
  Jumuah: ['jumua', 'jummah', 'jumma', 'juma'],
  Duha: ['dhuha'],
  Taraweeh: ['tarawih', 'taraweh', 'tarawee'],
  Qiyam: ['qiyaam', 'qiam'],
  Tahajjud: ['tahajud', 'tahajjad'],
  Witr: ['witir', 'wittr'],
  Eid: ['eed', 'eidprayer'],
  Istisqa: ['istisqah'],
  Kusuf: ['khusuf', 'kusoof'],
}

const LOOKUP: Readonly<Record<string, string>> = (() => {
  const m: Record<string, string> = {}
  for (const p of PRAYERS) { m[p.toLowerCase()] = p; for (const a of ALIASES[p] ?? []) m[a] = p }
  return m
})()

/** Every accepted spelling, longest first (for longest-match tokenizing). */
export const PRAYER_SPELLINGS: readonly string[] = Object.keys(LOOKUP).sort((a, b) => b.length - a.length)

/** Case-insensitive lookup of any accepted spelling → canonical prayer name, or null. */
export function canonicalPrayer(raw: string): string | null {
  return LOOKUP[raw.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? null
}
