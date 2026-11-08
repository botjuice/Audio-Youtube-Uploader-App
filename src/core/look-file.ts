/**
 * Thumbnail look files: export a rule's knobs to JSON and import them again, here or on another machine.
 *
 * The file carries both the rule's own changes (`knobs`) and the fully resolved look (`look`), so an
 * overlay can take just the changes while a base rule can take the exact picture. Custom font files the
 * knobs point at travel inside the file (base64) and are restored into the library on import.
 *
 * Compatibility: the plugin accepts any subset of knobs and fills the rest with its defaults, so a file
 * from an older plugin simply lacks the newer knobs. A file from a newer plugin may carry knobs this
 * plugin doesn't know, or values outside a changed range: `sanitisePatch` drops only those, one by one,
 * and reports them, instead of refusing the whole file.
 */
import type { StyleError, StylePatch, ThumbnailRule } from '@shared/types'
import { getKnob, setKnob } from './thumb-rules'

export const LOOK_FILE_FORMAT = 'yoosy-joosy.thumbnail-look'
export const LOOK_FILE_VERSION = 1

export interface LookFileFont { name: string; data: string }   // base64 file contents
export interface LookFile {
  format: typeof LOOK_FILE_FORMAT
  version: number
  app: string
  appVersion: string
  styleVersion: number
  exportedAt: string
  rule: { label?: string; overlay: boolean; default: boolean }
  /** the rule's own changes, relative to what it inherits (Default look, or the plugin for the Default look) */
  knobs: StylePatch
  /** every knob as the rule renders it (its inherited values + its own changes) */
  look: StylePatch
  /** custom font files referenced by `knobs`/`look`, keyed by the path they use */
  fonts?: Record<string, LookFileFont>
}

export function buildLookFile(
  rule: Pick<ThumbnailRule, 'label' | 'overlay' | 'origin' | 'style'>, look: StylePatch,
  meta: { appVersion: string; styleVersion: number; now?: Date }, fonts: Record<string, LookFileFont> = {},
): LookFile {
  return {
    format: LOOK_FILE_FORMAT, version: LOOK_FILE_VERSION, app: 'YouTube Quran Uploader', appVersion: meta.appVersion, styleVersion: meta.styleVersion,
    exportedAt: (meta.now ?? new Date()).toISOString(),
    rule: { ...(rule.label?.trim() ? { label: rule.label.trim() } : {}), overlay: !!rule.overlay, default: rule.origin === 'default' },
    knobs: rule.style ?? {}, look, ...(Object.keys(fonts).length ? { fonts } : {}),
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Parse the JSON of a look file; throws a plain-words error when it isn't one. */
export function parseLookFile(text: string): LookFile {
  let j: unknown
  try { j = JSON.parse(text) } catch { throw new Error('That file is not valid JSON.') }
  if (!isObj(j) || j['format'] !== LOOK_FILE_FORMAT) throw new Error('That file is not a thumbnail look exported from this app.')
  if (typeof j['version'] !== 'number' || j['version'] > LOOK_FILE_VERSION) throw new Error(`That look file is from a newer version of the app (file version ${String(j['version'])}). Update the app to import it.`)
  const knobs = isObj(j['knobs']) ? j['knobs'] : {}
  const look = isObj(j['look']) ? j['look'] : knobs
  const rule = isObj(j['rule']) ? j['rule'] : {}
  const fonts: Record<string, LookFileFont> = {}
  if (isObj(j['fonts'])) for (const [k, v] of Object.entries(j['fonts'])) if (isObj(v) && typeof v['name'] === 'string' && typeof v['data'] === 'string') fonts[k] = { name: v['name'], data: v['data'] }
  return {
    format: LOOK_FILE_FORMAT, version: j['version'], app: String(j['app'] ?? ''), appVersion: String(j['appVersion'] ?? ''),
    styleVersion: typeof j['styleVersion'] === 'number' ? j['styleVersion'] : 0, exportedAt: String(j['exportedAt'] ?? ''),
    rule: { ...(typeof rule['label'] === 'string' ? { label: rule['label'] } : {}), overlay: rule['overlay'] === true, default: rule['default'] === true },
    knobs: knobs as StylePatch, look: look as StylePatch, ...(Object.keys(fonts).length ? { fonts } : {}),
  }
}

/** Drop the knobs the plugin rejects (unknown, out of range, wrong type), one problem at a time, and say which. */
export function sanitisePatch(patch: StylePatch, problems: (p: StylePatch) => StyleError[]): { patch: StylePatch; dropped: string[] } {
  let cur = patch as Record<string, unknown>
  const dropped: string[] = []
  for (let i = 0; i < 200; i++) {
    const errs = problems(cur as StylePatch)
    if (!errs.length) break
    const e = errs[0]!
    if (getKnob(cur, e.key) === undefined) break   // can't locate it — stop rather than loop
    cur = setKnob(cur, e.key, undefined)
    dropped.push(`${e.key} (${e.message})`)
  }
  return { patch: prune(cur) as StylePatch, dropped }
}

/** Remove undefined leaves and empty groups left behind by deletions. */
function prune(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (isObj(v)) { const inner = prune(v); if (Object.keys(inner).length) out[k] = inner }
    else out[k] = v
  }
  return out
}

/** Every string leaf that looks like a file path (a custom font), with its dotted path. */
export function pathKnobs(patch: StylePatch): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = []
  const walk = (o: unknown, prefix: string) => {
    if (!isObj(o)) return
    for (const [k, v] of Object.entries(o)) {
      if (isObj(v)) walk(v, `${prefix}${k}.`)
      else if (typeof v === 'string' && (v.includes('/') || v.includes('\\'))) out.push({ path: prefix + k, value: v })
    }
  }
  walk(patch, '')
  return out
}

/** Replace string leaves equal to a key of `map` with its value (used to point imported knobs at restored font files). */
export function remapStrings(patch: StylePatch, map: Record<string, string>): StylePatch {
  let cur = patch
  for (const { path, value } of pathKnobs(patch)) if (map[value] !== undefined) cur = setKnob(cur as Record<string, unknown>, path, map[value]) as StylePatch
  return cur
}
