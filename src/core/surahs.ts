import defaults from './surahs.json'

export type SurahDict = Record<string, string>

/** Normalise any spelling to a dictionary key: lowercase, alphanumerics only. */
export function surahKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The shipped alias dictionary (key → Arabic). Apps may layer user edits on top. */
export const DEFAULT_SURAHS: SurahDict = defaults as SurahDict

export function isKnownSurah(name: string, dict: SurahDict = DEFAULT_SURAHS): boolean {
  return surahKey(name) in dict
}

export function translateSurah(name: string, dict: SurahDict = DEFAULT_SURAHS): string {
  return dict[surahKey(name)] ?? name
}
