/**
 * Style knobs — the single source of truth.
 *
 * Every knob is declared once here (type, range, default, description). Validation, defaults,
 * the cache key, the CLI sweep, the docs and any slider UI are all derived from this table.
 * Defaults reproduce the locked design exactly: an empty style renders today's pixels.
 *
 * Numbers are decimals on a slider between min and max. Colours are passed through from a
 * colour picker as #RGB, #RRGGBB, #RRGGBBAA, rgb(...) or rgba(...).
 */

import { BUNDLED_FONTS, FONT_BY_ID, FONT_FILE_EXTS, customFamily } from './fonts'

// ── Schema types ─────────────────────────────────────────────────────────────

export interface NumberField { kind: 'number'; min: number; max: number; default: number; step: number; desc: string }
export interface ColorField { kind: 'color'; default: string; desc: string }
/** A bundled font id, or an absolute path to the user's own font file. `options` lists the bundled ids for pickers. */
export interface FontField { kind: 'font'; default: string; desc: string; options: readonly { id: string; label: string; style: string }[] }
export type Field = NumberField | ColorField | FontField
export interface Group { readonly [key: string]: Field | Group }

const num = (min: number, max: number, def: number, desc: string, step = 0.01): NumberField => ({ kind: 'number', min, max, default: def, step, desc })
const color = (def: string, desc: string): ColorField => ({ kind: 'color', default: def, desc })
const font = (def: string, desc: string): FontField => ({ kind: 'font', default: def, desc, options: BUNDLED_FONTS.map((f) => ({ id: f.id, label: f.label, style: f.style })) })

/** Is this a usable font value: a bundled id, or an absolute path to a font file? (Existence is checked at render.)
 *  No Node imports here: the app's renderer type-checks this file too. */
export function isFontValue(v: unknown): v is string {
  if (typeof v !== 'string' || !v.trim()) return false
  if (FONT_BY_ID.has(v)) return true
  const absolute = v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)
  const ext = (/\.[^./\\]+$/.exec(v)?.[0] ?? '').toLowerCase()
  return absolute && (FONT_FILE_EXTS as readonly string[]).includes(ext)
}

const pill = (desc: string) => ({
  opacity: num(0, 1, 0, `${desc}: backdrop pill opacity; 0 = no pill`),
  color: color('#0B1A26', `${desc}: pill colour`),
  radius: num(0, 60, 16, `${desc}: pill corner radius, px`, 1),
  paddingX: num(0, 60, 24, `${desc}: pill horizontal padding, px`, 1),
  paddingY: num(0, 30, 8, `${desc}: pill vertical padding, px`, 1),
}) satisfies Group
const divider = (desc: string) => ({
  opacity: num(0, 1, 0, `${desc}: divider opacity; 0 = hidden`),
  width: num(40, 800, 120, `${desc}: divider width, px`, 1),
  thickness: num(1, 8, 3, `${desc}: divider thickness, px`, 0.5),
  color: color('#EBD27A', `${desc}: divider colour`),
}) satisfies Group

export const STYLE_SCHEMA = {
  photo: {
    focusX: num(0, 100, 50, 'Which part of the photo survives the 16:9 crop, horizontally (%)', 1),
    focusY: num(0, 100, 50, 'Same, vertically (%)', 1),
    zoom: num(1, 2.5, 1, 'Scale the photo around the focus point'),
    blur: num(0, 16, 8, 'Blur radius, px', 0.5),
    brightness: num(0.2, 1.6, 1, 'Brightness multiplier'),
    contrast: num(0.5, 1.6, 1.24, 'Contrast multiplier'),
    saturation: num(0, 2, 1, 'Saturation multiplier; 0 = black & white'),
    hue: num(0, 360, 0, 'Hue rotation, degrees', 1),
    sepia: num(0, 1, 0, 'Sepia tone amount'),
    grain: num(0, 1, 0, 'Film grain amount'),
  },
  overlay: {
    color: color('#0B1A26', 'Tint colour for all overlay layers'),
    top: num(0, 1, 0.25, 'Darkness at the start of the gradient'),
    middle: num(0, 1, 0.25, 'Darkness at the middle of the gradient'),
    bottom: num(0, 1, 0.25, 'Darkness at the end of the gradient'),
    angle: num(0, 360, 180, 'Gradient direction, degrees (180 = top to bottom)', 1),
    vignetteStrength: num(0, 1.5, 0.76, 'Edge darkening multiplier'),
    vignetteSize: num(50, 150, 100, 'How far in the edge darkening reaches (%)', 1),
    scrimStrength: num(0, 1.5, 1.5, 'Soft dark patch behind the text, multiplier'),
    scrimSize: num(20, 100, 37, 'Size of the patch (% of canvas)', 1),
  },
  text: {
    offsetX: num(-250, 250, 0, 'Shift the whole text group horizontally, px', 1),
    offsetY: num(-120, 120, -20, 'Shift the whole text group vertically, px; negative = up', 1),
    width: num(0.5, 0.95, 0.95, 'Maximum width of the text box, fraction of the canvas'),
    gapAboveTitle: num(0, 90, 16, 'Space between the reciter line and the title, px', 1),
    gapBelowTitle: num(0, 90, 40, 'Space between the title and the prayer · date line, px', 1),
  },
  shadow: {
    color: color('#000000', 'Drop-shadow colour for all text'),
    opacity: num(0, 1, 0.55, 'Drop-shadow opacity'),
    blur: num(0, 40, 12, 'Drop-shadow blur, px', 0.5),
    offsetY: num(-20, 20, 2, 'Drop-shadow vertical offset, px', 0.5),
  },
  title: {
    color: color('#D6B33C', 'Surah calligraphy colour; gradient stops are derived from it'),
    gradient: num(0, 1, 1, 'Gradient spread; 0 = flat colour'),
    gradientAngle: num(0, 360, 180, 'Gradient direction, degrees', 1),
    scale: num(0.5, 1.15, 0.9, 'Calligraphy size multiplier (1.15 = widest single surah still fits)'),
    opacity: num(0, 1, 1, 'Calligraphy opacity'),
    glow: num(0, 2, 1, 'Glow strength multiplier'),
    glowColor: color('#EBD27A', 'Glow colour'),
    glowSize: num(0, 60, 22, 'Glow radius, px', 1),
    outlineWidth: num(0, 6, 0, 'Outline around the calligraphy, px; 0 = none', 0.5),
    outlineColor: color('#000000', 'Outline colour'),
    surahWordScale: num(0, 1.2, 1, 'Size of the word «سورة» relative to the name; 0 hides it'),
    surahWordGap: num(0, 0.4, 0.14, 'Gap between «سورة» and the name, em'),
    joinScale: num(0.2, 0.6, 0.38, 'Size of the «و» between two surahs, relative to the names'),
  },
  reciter: {
    font: font('tajawal', 'Reciter name font: a bundled font id, or an absolute path to your own .ttf/.otf/.woff/.woff2'),
    color: color('#F4EFE3', 'Reciter name colour'),
    scale: num(0.5, 1.6, 1.3, 'Reciter name size multiplier'),
    opacity: num(0, 1, 1, 'Reciter line opacity; 0 hides it and the group re-centres'),
    letterSpacing: num(-0.05, 0.3, 0, 'Letter spacing, em', 0.005),
    pill: pill('Reciter'),
  },
  meta: {
    font: font('reem-kufi', 'Prayer · date font: a bundled font id, or an absolute path to your own font file'),
    color: color('#F4EFE3', 'Prayer · date colour'),
    scale: num(0.5, 1.6, 1.38, 'Prayer · date size multiplier'),
    opacity: num(0, 1, 1, 'Whole line opacity; 0 hides it'),
    prayerOpacity: num(0, 1, 1, 'Prayer opacity; 0 hides it and its separator'),
    dateOpacity: num(0, 1, 1, 'Date opacity; 0 hides it and its separator'),
    letterSpacing: num(-0.05, 0.3, 0, 'Letter spacing, em', 0.005),
    gap: num(0.1, 1.5, 0.37, 'Space either side of the separator, em'),
    separatorColor: color('#FFFFFF', 'Separator dot colour'),
    separatorSize: num(0, 16, 7, 'Separator dot size, px; 0 hides it', 0.5),
    pill: pill('Prayer · date'),
  },
  dividers: {
    aboveTitle: divider('Divider between reciter and title'),
    belowTitle: divider('Divider between title and prayer · date'),
  },
  frame: {
    width: num(0, 40, 0, 'Border width, px; 0 = none', 0.5),
    color: color('#EBD27A', 'Border colour'),
    opacity: num(0, 1, 1, 'Border opacity'),
    inset: num(0, 60, 24, 'Distance from the canvas edge, px', 1),
    radius: num(0, 40, 0, 'Border corner radius, px', 1),
  },
  output: {
    quality: num(60, 100, 90, 'JPEG quality for both files (thumbnail still kept under 2 MB)', 1),
  },
} as const satisfies Group

// ── Types derived from the schema ────────────────────────────────────────────

type FieldValue<F> = F extends NumberField ? number : F extends ColorField | FontField ? string : F extends Group ? Resolve<F> : never
type Resolve<G> = { -readonly [K in keyof G]: FieldValue<G[K]> }
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** A fully resolved style: every knob has a value. */
export type Style = Resolve<typeof STYLE_SCHEMA>
/** What a caller passes: any subset of knobs, nested as in the schema. */
export type StylePatch = DeepPartial<Style>

export interface StyleError { key: string; message: string }

// ── Defaults ─────────────────────────────────────────────────────────────────

function defaultsOf(group: Group): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(group)) out[k] = 'kind' in f ? f.default : defaultsOf(f as Group)
  return out
}
export const DEFAULT_STYLE: Style = defaultsOf(STYLE_SCHEMA) as Style

/** Flat list of every knob with its dotted path, e.g. "title.scale" — for slider UIs and docs. */
export interface StyleFieldInfo { path: string; field: Field }
export const STYLE_FIELDS: readonly StyleFieldInfo[] = (function walk(group: Group, prefix: string): StyleFieldInfo[] {
  return Object.entries(group).flatMap(([k, f]) => ('kind' in f ? [{ path: prefix + k, field: f as Field }] : walk(f as Group, `${prefix}${k}.`)))
})(STYLE_SCHEMA, '')

// ── Colours ──────────────────────────────────────────────────────────────────

export interface Rgba { r: number; g: number; b: number; a: number }

/** Accepts #RGB, #RGBA, #RRGGBB, #RRGGBBAA, rgb(r,g,b), rgba(r,g,b,a) (also the space/slash form). */
export function parseColor(input: unknown): Rgba | null {
  if (typeof input !== 'string') return null
  const s = input.trim()
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s)
  if (m) {
    let h = m[1]!
    if (h.length <= 4) h = [...h].map((c) => c + c).join('')
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 }
  }
  m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(s)
  if (m) {
    const c = [m[1], m[2], m[3]].map(Number)
    if (c.some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return null
    let a = 1
    if (m[4] !== undefined) { a = m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]); if (!Number.isFinite(a) || a < 0 || a > 1) return null }
    return { r: c[0]!, g: c[1]!, b: c[2]!, a }
  }
  return null
}

export const rgba = (c: Rgba, alphaMul = 1): string => `rgba(${c.r}, ${c.g}, ${c.b}, ${+(c.a * alphaMul).toFixed(3)})`
export const rgbTriplet = (c: Rgba): string => `${c.r}, ${c.g}, ${c.b}`

export interface Hsl { h: number; s: number; l: number }

export function rgbToHsl(c: Rgba): Hsl {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return { h: 0, s: 0, l }
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return { h, s, l }
}

export function hslToRgb({ h, s, l }: Hsl, a = 1): Rgba {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let r = l, g = l, b = l
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
    r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3)
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255), a }
}

/** Apply an HSL delta, scaled by `amount`, with s and l clamped. */
export function shiftHsl(c: Rgba, delta: Hsl, amount = 1): Rgba {
  const x = rgbToHsl(c)
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return hslToRgb({ h: ((x.h + delta.h * amount) % 1 + 1) % 1, s: clamp(x.s + delta.s * amount), l: clamp(x.l + delta.l * amount) }, c.a)
}

/** The locked design's gold gradient: base #D6B33C with a lighter top stop and a deeper bottom
 *  stop. The two deltas below are exactly the HSL difference between those hand-picked stops and
 *  the base, so the default colour reproduces them exactly and any other colour gets the same
 *  relative treatment. */
const LOCKED_GOLD = { base: parseColor('#D6B33C')!, light: parseColor('#EBD27A')!, deep: parseColor('#B9962B')! }
const hslDelta = (from: Rgba, to: Rgba): Hsl => { const a = rgbToHsl(from), b = rgbToHsl(to); return { h: b.h - a.h, s: b.s - a.s, l: b.l - a.l } }
const LIGHT_DELTA = hslDelta(LOCKED_GOLD.base, LOCKED_GOLD.light)
const DEEP_DELTA = hslDelta(LOCKED_GOLD.base, LOCKED_GOLD.deep)

/** Gradient stops for any base colour: `spread` 1 = the locked look, 0 = flat. */
export function gradientStops(base: Rgba, spread: number): { light: Rgba; deep: Rgba } {
  return { light: shiftHsl(base, LIGHT_DELTA, spread), deep: shiftHsl(base, DEEP_DELTA, spread) }
}

// ── Validation ───────────────────────────────────────────────────────────────

/** Validate a style patch against the schema. Rejects unknown keys, wrong types, out-of-range
 *  numbers and bad colours — every problem is listed with its dotted key. Returns the resolved style. */
export function validateStyle(input: unknown): { ok: true; style: Style } | { ok: false; errors: StyleError[] } {
  const errors: StyleError[] = []
  const walk = (group: Group, patch: unknown, prefix: string): Record<string, unknown> => {
    const out = defaultsOf(group)
    if (patch === undefined || patch === null) return out
    if (typeof patch !== 'object' || Array.isArray(patch)) { errors.push({ key: prefix.replace(/\.$/, '') || 'style', message: 'must be an object' }); return out }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      const f = group[k]
      const key = prefix + k
      if (!f) { errors.push({ key, message: 'unknown knob' }); continue }
      if (v === undefined) continue
      if (!('kind' in f)) { out[k] = walk(f as Group, v, `${key}.`); continue }
      if (f.kind === 'number') {
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ key, message: `must be a number between ${f.min} and ${f.max}, got ${JSON.stringify(v)}` })
        else if (v < f.min || v > f.max) errors.push({ key, message: `must be between ${f.min} and ${f.max}, got ${v}` })
        else out[k] = v
      } else if (f.kind === 'font') {
        if (!isFontValue(v)) errors.push({ key, message: `must be a bundled font id (${BUNDLED_FONTS.map((b) => b.id).join(', ')}) or an absolute path to a .ttf/.otf/.woff/.woff2 file, got ${JSON.stringify(v)}` })
        else out[k] = (v as string).trim()
      } else {
        if (!parseColor(v)) errors.push({ key, message: `must be a colour like #RRGGBB, #RRGGBBAA or rgba(r, g, b, a), got ${JSON.stringify(v)}` })
        else out[k] = (v as string).trim()
      }
    }
    return out
  }
  const style = walk(STYLE_SCHEMA, input, '') as Style
  return errors.length ? { ok: false, errors } : { ok: true, style }
}

/** Schema-ordered JSON of a resolved style, so key order in the input never changes the cache key. */
/** Custom font files referenced by a style (absolute paths), per line. Empty when only bundled fonts are used. */
export function customFontFiles(s: Style): Partial<Record<'reciter' | 'meta', string>> {
  const out: Partial<Record<'reciter' | 'meta', string>> = {}
  if (!FONT_BY_ID.has(s.reciter.font)) out.reciter = s.reciter.font
  if (!FONT_BY_ID.has(s.meta.font)) out.meta = s.meta.font
  return out
}

export function canonicalStyle(style: Style): string {
  const order = (group: Group, value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, f] of Object.entries(group)) out[k] = 'kind' in f ? value[k] : order(f as Group, value[k] as Record<string, unknown>)
    return out
  }
  return JSON.stringify(order(STYLE_SCHEMA, style as unknown as Record<string, unknown>))
}

// ── Style → CSS variables (how a knob becomes pixels) ────────────────────────

const LOCKED = { title: 290, reciter: 52, meta: 36, canvasW: 1280 } as const
const px = (n: number) => `${+n.toFixed(2)}px`
const c = (s: string) => parseColor(s)!

/** Below this shrink ratio the text is unreadable at feed size; the template stops shrinking here and the render is refused. */
export const MIN_FIT = 0.55

/** Margin the text group must keep from the canvas edge: 24px, or clear of the frame when one is drawn. */
export function safeMargin(s: Style): number {
  const frameOn = s.frame.width > 0 && s.frame.opacity > 0
  return frameOn ? Math.max(24, Math.round(s.frame.inset + s.frame.width + 12)) : 24
}

/** Everything the template needs, as CSS custom properties. The template only reads these. */
export function cssVars(s: Style): Record<string, string> {
  const overlay = c(s.overlay.color), shadow = c(s.shadow.color), title = c(s.title.color), glow = c(s.title.glowColor)
  const { light, deep } = gradientStops(title, s.title.gradient)
  const sh = (oy: number, blur: number, alphaMul: number) => `${px(oy)} ${px(blur)} ${rgba(shadow, s.shadow.opacity * alphaMul)}`
  // Fit boxes never exceed the room inside the safe margin, so shrink-to-fit targets what can actually be shown.
  const titleMaxW = Math.min(Math.round(LOCKED.canvasW * s.text.width), LOCKED.canvasW - 2 * safeMargin(s))
  const scrimCx = `calc(50% + ${px(s.text.offsetX)})`, scrimCy = `calc(52% + ${px(s.text.offsetY + 30)})`
  const metaOn = s.meta.opacity > 0 && (s.meta.prayerOpacity > 0 || s.meta.dateOpacity > 0)
  const pillVars = (p: Style['reciter']['pill'], prefix: string) => ({
    [`--${prefix}-pill-bg`]: p.opacity > 0 ? rgba(c(p.color), p.opacity) : 'transparent',
    [`--${prefix}-pill-radius`]: px(p.radius),
    [`--${prefix}-pill-px`]: px(p.opacity > 0 ? p.paddingX : 0),
    [`--${prefix}-pill-py`]: px(p.opacity > 0 ? p.paddingY : 0),
  })
  const dividerVars = (d: Style['dividers']['aboveTitle'], prefix: string) => ({
    [`--${prefix}-display`]: d.opacity > 0 ? 'block' : 'none',
    [`--${prefix}-width`]: px(d.width),
    [`--${prefix}-height`]: px(d.thickness),
    [`--${prefix}-bg`]: `linear-gradient(90deg, transparent, ${rgba(c(d.color), d.opacity)}, transparent)`,
  })

  const fontVars = (line: 'reciter' | 'meta', value: string) => {
    const b = FONT_BY_ID.get(value)
    const family = b ? b.id : customFamily(line)
    const weight = b ? (line === 'reciter' ? b.reciterWeight : b.metaWeight) : (line === 'reciter' ? 700 : 500)
    return { [`--${line}-font`]: `"${family}"`, [`--${line}-weight`]: String(weight) }
  }

  return {
    '--safe': px(safeMargin(s)),
    '--min-fit': String(MIN_FIT),
    ...fontVars('reciter', s.reciter.font),
    ...fontVars('meta', s.meta.font),
    // photo
    '--photo-position': `${s.photo.focusX}% ${s.photo.focusY}%`,
    '--photo-transform': `scale(${s.photo.zoom})`,
    '--photo-filter': `blur(${px(s.photo.blur)}) brightness(${s.photo.brightness}) contrast(${s.photo.contrast}) saturate(${s.photo.saturation}) hue-rotate(${s.photo.hue}deg) sepia(${s.photo.sepia})`,
    '--grain-opacity': String(s.photo.grain),
    // overlay: scrim behind the text, vignette, directional gradient
    '--overlay-bg': [
      `radial-gradient(${+(58 * s.overlay.scrimSize / 60).toFixed(1)}% ${+(60 * s.overlay.scrimSize / 60).toFixed(1)}% at ${scrimCx} ${scrimCy}, ${rgba(overlay, 0.30 * s.overlay.scrimStrength)} 0%, ${rgba(overlay, 0)} 100%)`,
      `radial-gradient(${+(120 * s.overlay.vignetteSize / 100).toFixed(1)}% ${+(90 * s.overlay.vignetteSize / 100).toFixed(1)}% at 50% 40%, ${rgba(overlay, 0)} 0%, ${rgba(overlay, 0.45 * s.overlay.vignetteStrength)} 100%)`,
      `linear-gradient(${s.overlay.angle}deg, ${rgba(overlay, s.overlay.top)} 0%, ${rgba(overlay, s.overlay.middle)} 45%, ${rgba(overlay, s.overlay.bottom)} 100%)`,
    ].join(', '),
    '--canvas-bg': rgba(overlay, 1),
    // text group
    '--text-offset-x': px(s.text.offsetX),
    '--text-offset-y': px(s.text.offsetY),
    '--title-max-w': px(titleMaxW),
    '--secondary-max-w': px(titleMaxW - 40),
    '--gap-above-title': px(s.text.gapAboveTitle),
    '--gap-below-title': px(s.text.gapBelowTitle),
    '--text-shadow': sh(s.shadow.offsetY, s.shadow.blur, 1),
    '--meta-shadow': sh(s.shadow.offsetY, s.shadow.blur * 10 / 12, 1),
    // title
    '--title-color': rgba(title),
    '--title-gradient': `linear-gradient(${s.title.gradientAngle}deg, ${rgba(light)} 0%, ${rgba(title)} 55%, ${rgba(deep)} 100%)`,
    '--title-size': px(LOCKED.title * s.title.scale),
    '--title-opacity': String(s.title.opacity),
    '--title-filter': `drop-shadow(0 ${sh(s.shadow.offsetY * 2, s.shadow.blur * 0.5, 0.82)}) drop-shadow(0 ${sh(s.shadow.offsetY * 5, s.shadow.blur * 28 / 12, 0.82)}) drop-shadow(0 0 ${px(s.title.glowSize)} ${rgba(glow, 0.30 * s.title.glow)})`,
    '--surah-word-display': s.title.surahWordScale > 0 ? 'inline-block' : 'none',
    '--surah-word-scale': `${s.title.surahWordScale}em`,
    '--title-gap': `${s.title.surahWordGap}em`,
    '--join-scale': `${s.title.joinScale}em`,
    '--outline-display': s.title.outlineWidth > 0 ? 'flex' : 'none',
    '--outline-stroke': `${px(s.title.outlineWidth * 2)} ${rgba(c(s.title.outlineColor))}`,
    // reciter
    '--reciter-display': s.reciter.opacity > 0 ? 'block' : 'none',
    '--reciter-color': rgba(c(s.reciter.color)),
    '--reciter-size': px(LOCKED.reciter * s.reciter.scale),
    '--reciter-opacity': String(s.reciter.opacity),
    '--reciter-spacing': `${s.reciter.letterSpacing}em`,
    ...pillVars(s.reciter.pill, 'reciter'),
    // meta
    '--meta-display': metaOn ? 'flex' : 'none',
    '--meta-color': rgba(c(s.meta.color), s.meta.opacity),
    '--meta-size': px(LOCKED.meta * s.meta.scale),
    '--meta-gap': `${s.meta.gap}em`,
    '--meta-spacing': `${s.meta.letterSpacing}em`,
    '--prayer-display': s.meta.prayerOpacity > 0 ? 'inline' : 'none',
    '--prayer-opacity': String(s.meta.prayerOpacity),
    '--date-display': s.meta.dateOpacity > 0 ? 'inline' : 'none',
    '--date-opacity': String(s.meta.dateOpacity),
    '--sep-display': s.meta.separatorSize > 0 && s.meta.prayerOpacity > 0 && s.meta.dateOpacity > 0 ? 'block' : 'none',
    '--sep-size': px(s.meta.separatorSize),
    '--sep-color': rgba(c(s.meta.separatorColor)),
    ...pillVars(s.meta.pill, 'meta'),
    // dividers
    ...dividerVars(s.dividers.aboveTitle, 'div-above'),
    ...dividerVars(s.dividers.belowTitle, 'div-below'),
    // frame
    '--frame-display': s.frame.width > 0 && s.frame.opacity > 0 ? 'block' : 'none',
    '--frame-border': `${px(s.frame.width)} solid ${rgba(c(s.frame.color), s.frame.opacity)}`,
    '--frame-inset': px(s.frame.inset),
    '--frame-radius': px(s.frame.radius),
  }
}
