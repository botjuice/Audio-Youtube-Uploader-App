/**
 * Bundled fonts for the reciter line and the prayer · date line.
 *
 * All are SIL Open Font Licence (licences in template/fonts/licences/). A style's `reciter.font`
 * or `meta.font` is either one of these ids or an absolute path to the user's own .ttf/.otf/.woff/.woff2.
 * The surah calligraphy font is fixed (ligature font); it is not part of this list.
 */

export interface BundledFont {
  id: string
  /** Display name for pickers. */
  label: string
  /** Short style tag for pickers. */
  style: string
  /** Files to declare: [file, weight range]. Variable fonts cover a range; statics are one weight each. */
  files: [file: string, weight: string][]
  /** Weight to request for the reciter line (700 where the family has it; 400 for single-weight fonts). */
  reciterWeight: number
  /** Weight to request for the prayer · date line. */
  metaWeight: number
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  // — the locked design's two —
  { id: 'amiri', label: 'Amiri', style: 'Naskh · classical', files: [['Amiri-Regular.ttf', '400'], ['Amiri-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'ibm-plex-sans-arabic', label: 'IBM Plex Sans Arabic', style: 'Modern sans · clean', files: [['IBMPlexSansArabic-Medium.ttf', '500']], reciterWeight: 500, metaWeight: 500 },
  // — traditional Naskh / calligraphic —
  { id: 'scheherazade-new', label: 'Scheherazade New', style: 'Naskh · traditional book', files: [['ScheherazadeNew-Regular.ttf', '400'], ['ScheherazadeNew-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'noto-naskh-arabic', label: 'Noto Naskh Arabic', style: 'Naskh · clean', files: [['NotoNaskhArabic[wght].ttf', '400 700']], reciterWeight: 700, metaWeight: 500 },
  { id: 'lateef', label: 'Lateef', style: 'Naskh · soft', files: [['Lateef-Regular.ttf', '400'], ['Lateef-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'harmattan', label: 'Harmattan', style: 'Warsh style · West African', files: [['Harmattan-Regular.ttf', '400'], ['Harmattan-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'markazi-text', label: 'Markazi Text', style: 'Naskh/Nastaliq blend · editorial', files: [['MarkaziText[wght].ttf', '400 700']], reciterWeight: 700, metaWeight: 500 },
  // — Ruq'ah / handwritten / Nastaliq —
  { id: 'aref-ruqaa', label: 'Aref Ruqaa', style: "Ruq'ah · handwritten", files: [['ArefRuqaa-Regular.ttf', '400'], ['ArefRuqaa-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'katibeh', label: 'Katibeh', style: 'Thuluth-inspired · display', files: [['Katibeh-Regular.ttf', '400']], reciterWeight: 400, metaWeight: 400 },
  { id: 'mirza', label: 'Mirza', style: 'Nastaliq-flavoured · ornate', files: [['Mirza-Regular.ttf', '400'], ['Mirza-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'gulzar', label: 'Gulzar', style: 'Nastaliq · calligraphic', files: [['Gulzar-Regular.ttf', '400']], reciterWeight: 400, metaWeight: 400 },
  // — Kufi / modern sans —
  { id: 'reem-kufi', label: 'Reem Kufi', style: 'Kufi · geometric', files: [['ReemKufi[wght].ttf', '400 700']], reciterWeight: 700, metaWeight: 500 },
  { id: 'noto-kufi-arabic', label: 'Noto Kufi Arabic', style: 'Kufi · modern', files: [['NotoKufiArabic[wght].ttf', '100 900']], reciterWeight: 700, metaWeight: 500 },
  { id: 'cairo', label: 'Cairo', style: 'Modern sans · rounded Kufi', files: [['Cairo[slnt,wght].ttf', '200 1000']], reciterWeight: 700, metaWeight: 500 },
  { id: 'tajawal', label: 'Tajawal', style: 'Modern sans · neutral', files: [['Tajawal-Regular.ttf', '400'], ['Tajawal-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'almarai', label: 'Almarai', style: 'Modern sans · UI-like', files: [['Almarai-Regular.ttf', '400'], ['Almarai-Bold.ttf', '700']], reciterWeight: 700, metaWeight: 400 },
  { id: 'el-messiri', label: 'El Messiri', style: 'Modern · Kufi-Naskh hybrid', files: [['ElMessiri[wght].ttf', '400 700']], reciterWeight: 700, metaWeight: 500 },
  { id: 'changa', label: 'Changa', style: 'Modern · condensed', files: [['Changa[wght].ttf', '200 800']], reciterWeight: 700, metaWeight: 500 },
  // — display / poster —
  { id: 'lalezar', label: 'Lalezar', style: 'Display · bold poster', files: [['Lalezar-Regular.ttf', '400']], reciterWeight: 400, metaWeight: 400 },
  { id: 'rakkas', label: 'Rakkas', style: "Display · Ruq'ah poster", files: [['Rakkas-Regular.ttf', '400']], reciterWeight: 400, metaWeight: 400 },
  { id: 'vibes', label: 'Vibes', style: 'Display · brushy', files: [['Vibes-Regular.ttf', '400']], reciterWeight: 400, metaWeight: 400 },
]

export const FONT_BY_ID: ReadonlyMap<string, BundledFont> = new Map(BUNDLED_FONTS.map((f) => [f.id, f]))

export const FONT_FILE_EXTS = ['.ttf', '.otf', '.woff', '.woff2'] as const

/** CSS family name used for a custom file on a given line. */
export const customFamily = (line: 'reciter' | 'meta') => `custom-${line}`

/** The @font-face block for every bundled font, generated so the template and this list can't drift. */
export function bundledFontFaceCss(): string {
  return BUNDLED_FONTS.flatMap((f) => f.files.map(([file, weight]) =>
    `@font-face { font-family: "${f.id}"; src: url("fonts/${file}") format("truetype"); font-weight: ${weight}; font-display: block; }`,
  )).join('\n')
}
