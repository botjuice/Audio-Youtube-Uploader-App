/**
 * Audio look knobs — the single source of truth.
 *
 * Every knob is declared once here: kind, range, step, default, unit, label and description.
 * Validation, defaults, the cache key, the chain builder, the CLI sweep and any slider UI are all
 * derived from this table. A look is stored as a *patch*: only the knobs that differ from the
 * defaults. An empty look = the factory chain (cleanup + loudness + fades).
 *
 * Numbers are decimals on a slider between min and max, moving in `step`. `scale: 'log'` marks
 * frequency-like knobs a UI should move logarithmically. Toggles are plain booleans.
 *
 * No Node imports here: the app's renderer may type-check and import this file for its editor.
 */

// ── Schema types ─────────────────────────────────────────────────────────────

export interface NumberField {
  kind: 'number'
  min: number; max: number; default: number; step: number
  /** Short unit for display next to the value: 'Hz', 'dB', 'ms', 's', 'LUFS', ':1', '' */
  unit: string
  /** Slider scale hint; 'log' for frequencies. */
  scale: 'linear' | 'log'
  label: string
  desc: string
}
export interface ToggleField { kind: 'toggle'; default: boolean; label: string; desc: string }
export type Field = NumberField | ToggleField
export interface Group { readonly [key: string]: Field | Group }

const num = (o: Omit<NumberField, 'kind' | 'scale'> & { scale?: NumberField['scale'] }): NumberField => ({ kind: 'number', scale: 'linear', ...o })
const toggle = (def: boolean, label: string, desc: string): ToggleField => ({ kind: 'toggle', default: def, label, desc })

/**
 * Chain order is fixed and follows the groups top to bottom:
 * cleanup → tone → dynamics → reverb → loudness → limiter → fades.
 */
export const LOOK_SCHEMA = {
  cleanup: {
    declip: {
      enabled: toggle(false, 'Repair clipping', 'Rebuilds peaks that were flattened by a recorder or PA turned up too far. Slow (≈2 s per minute of audio); only worth it when analysis reports clipping.'),
    },
    clicks: {
      enabled: toggle(true, 'Remove clicks', 'Removes short clicks and pops (mic bumps, digital glitches). Leaves the voice untouched.'),
    },
    rumble: {
      enabled: toggle(true, 'Cut rumble', 'Removes low hum and rumble (air conditioning, PA, traffic) below the cut-off.'),
      frequency: num({ min: 40, max: 150, default: 75, step: 1, unit: 'Hz', scale: 'log', label: 'Cut-off', desc: 'Everything below this is removed (24 dB/octave). A male voice reaches down to about 85–100 Hz, so keep it below 90 Hz unless the hum is higher.' }),
    },
    hiss: {
      enabled: toggle(true, 'Reduce hiss', 'Lowers steady background noise (hiss, fans, room tone). The noise is learned continuously, so it adapts as the room changes.'),
      amount: num({ min: 1, max: 30, default: 12, step: 0.5, unit: 'dB', label: 'Reduction', desc: 'How much the noise is lowered. Above ~18 dB long drawn-out notes (madd) can start to sound washed or watery.' }),
    },
  },
  tone: {
    enabled: toggle(false, 'Tone (EQ)', 'Shapes the colour of the voice. Off = the voice keeps its recorded tone.'),
    mud: {
      gain: num({ min: -9, max: 3, default: -1.5, step: 0.5, unit: 'dB', label: 'Warmth / mud', desc: 'Negative removes boxy, muddy sound; positive adds body.' }),
      frequency: num({ min: 120, max: 600, default: 250, step: 5, unit: 'Hz', scale: 'log', label: 'Warmth frequency', desc: 'Centre of the warmth band.' }),
    },
    presence: {
      gain: num({ min: -6, max: 9, default: 2.5, step: 0.5, unit: 'dB', label: 'Clarity', desc: 'Positive makes letters clearer and brings the voice forward.' }),
      frequency: num({ min: 1500, max: 6000, default: 3000, step: 50, unit: 'Hz', scale: 'log', label: 'Clarity frequency', desc: 'Centre of the clarity band.' }),
    },
    air: {
      gain: num({ min: -6, max: 6, default: 0, step: 0.5, unit: 'dB', label: 'Air', desc: 'Brightness of the very top. Positive also raises any remaining hiss.' }),
      frequency: num({ min: 6000, max: 14000, default: 9000, step: 100, unit: 'Hz', scale: 'log', label: 'Air frequency', desc: 'Everything above this frequency is raised or lowered.' }),
    },
    deesser: num({ min: 0, max: 1, default: 0, step: 0.05, unit: '', label: 'De-esser', desc: 'Softens harsh "s" sounds. 0 = off. Keep low: س ص ش ز must stay articulated for tajweed.' }),
  },
  dynamics: {
    enabled: toggle(false, 'Compressor', 'Evens out loud and soft passages. Most recordings are already even (mosque PA), so this is off by default.'),
    threshold: num({ min: -40, max: -5, default: -20, step: 0.5, unit: 'dB', label: 'Threshold', desc: 'Passages louder than this are turned down.' }),
    ratio: num({ min: 1, max: 8, default: 2, step: 0.1, unit: ':1', label: 'Ratio', desc: 'How strongly: 2:1 is gentle, 4:1 firm, 8:1 heavy.' }),
    attack: num({ min: 1, max: 200, default: 20, step: 1, unit: 'ms', label: 'Attack', desc: 'How fast it reacts. Faster tames sudden peaks but can dull letters.' }),
    release: num({ min: 20, max: 1500, default: 250, step: 10, unit: 'ms', label: 'Release', desc: 'How fast it lets go. Too short sounds pumpy on long notes.' }),
  },
  reverb: {
    enabled: toggle(false, 'Reverb', 'Adds a sense of space. Recordings already carry the masjid\'s own echo, so use it subtly. Turning it on makes the audio stereo.'),
    amount: num({ min: -30, max: -3, default: -16, step: 0.5, unit: 'dB', label: 'Amount', desc: 'Echo level relative to the voice: −16 dB = subtle, −10 dB = clearly audible, −4 dB = very wet.' }),
    decay: num({ min: 0.3, max: 6, default: 1.2, step: 0.1, unit: 's', label: 'Size (decay)', desc: 'How long the echo takes to fade away: about 1 s small room, 2 s hall, 3–4 s large masjid.' }),
    predelay: num({ min: 0, max: 120, default: 15, step: 1, unit: 'ms', label: 'Pre-delay', desc: 'Gap before the echo starts. Larger keeps the voice clearer and makes the space feel bigger.' }),
    tone: num({ min: 1500, max: 12000, default: 5500, step: 100, unit: 'Hz', scale: 'log', label: 'Echo brightness', desc: 'Top frequency of the echo. Lower = darker, softer echo like stone and carpet.' }),
    width: num({ min: 0, max: 1, default: 0.8, step: 0.05, unit: '', label: 'Width', desc: '0 = echo in the centre, 1 = fully spread left/right.' }),
  },
  loudness: {
    enabled: toggle(true, 'Even out volume', 'Brings every recording to the same loudness, so videos don\'t jump in volume one after another.'),
    target: num({ min: -24, max: -10, default: -14, step: 0.5, unit: 'LUFS', label: 'Target loudness', desc: '−14 is YouTube\'s playback reference: louder uploads are turned down by YouTube anyway.' }),
  },
  limiter: {
    ceiling: num({ min: -6, max: -0.5, default: -1.5, step: 0.1, unit: 'dB', label: 'Peak ceiling', desc: 'Peaks never go above this. Always applied, even with volume levelling off, so the file can never clip.' }),
  },
  fades: {
    in: num({ min: 0, max: 5, default: 0.5, step: 0.1, unit: 's', label: 'Fade in', desc: 'Fade at the start. 0 = none.' }),
    out: num({ min: 0, max: 10, default: 1.5, step: 0.1, unit: 's', label: 'Fade out', desc: 'Fade at the end. 0 = none.' }),
  },
} as const satisfies Group

// ── Types derived from the schema ────────────────────────────────────────────

type FieldValue<F> = F extends NumberField ? number : F extends ToggleField ? boolean : F extends Group ? Resolve<F> : never
type Resolve<G> = { -readonly [K in keyof G]: FieldValue<G[K]> }
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

/** A fully resolved look: every knob has a value. */
export type Look = Resolve<typeof LOOK_SCHEMA>
/** What a caller passes and what the app stores: any subset of knobs, nested as in the schema. */
export type LookPatch = DeepPartial<Look>

export interface LookError { key: string; message: string }

// ── Defaults & flat field list ───────────────────────────────────────────────

function defaultsOf(group: Group): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(group)) out[k] = 'kind' in f ? f.default : defaultsOf(f as Group)
  return out
}
export const DEFAULT_LOOK: Look = defaultsOf(LOOK_SCHEMA) as Look

/** Flat list of every knob with its dotted path, e.g. "reverb.decay" — in chain order, for editors and docs. */
export interface LookFieldInfo { path: string; field: Field }
export const LOOK_FIELDS: readonly LookFieldInfo[] = (function walk(group: Group, prefix: string): LookFieldInfo[] {
  return Object.entries(group).flatMap(([k, f]) => ('kind' in f ? [{ path: prefix + k, field: f as Field }] : walk(f as Group, `${prefix}${k}.`)))
})(LOOK_SCHEMA, '')

/** The toggle that switches a knob's section on/off (e.g. "reverb.decay" → "reverb.enabled"), so a UI can grey it out. */
export function controllingToggle(path: string): string | null {
  const parts = path.split('.')
  for (let i = parts.length - 1; i > 0; i--) {
    const candidate = [...parts.slice(0, i), 'enabled'].join('.')
    if (candidate !== path && LOOK_FIELDS.some((f) => f.path === candidate)) return candidate
  }
  return null
}

// ── Presets (patches; a UI writes them into the look) ────────────────────────

/** Reverb spaces: one click sets decay, pre-delay, brightness and a sensible amount. */
export const REVERB_PRESETS = {
  room:   { label: 'Small room', patch: { reverb: { enabled: true, decay: 0.9, predelay: 10, tone: 6000, amount: -16, width: 0.7 } } },
  hall:   { label: 'Hall',       patch: { reverb: { enabled: true, decay: 2.2, predelay: 25, tone: 5000, amount: -14, width: 0.85 } } },
  masjid: { label: 'Masjid',     patch: { reverb: { enabled: true, decay: 3.5, predelay: 40, tone: 4000, amount: -13, width: 1 } } },
} as const satisfies Record<string, { label: string; patch: LookPatch }>

/** Whole-look starting points. */
export const LOOK_PRESETS = {
  standard: { label: 'Standard clean-up', patch: {} },
  strong:   { label: 'Noisy recording', patch: { cleanup: { hiss: { amount: 18 }, rumble: { frequency: 90 } } } },
  original: { label: 'Only even out volume', patch: { cleanup: { clicks: { enabled: false }, rumble: { enabled: false }, hiss: { enabled: false } }, fades: { in: 0, out: 0 } } },
} as const satisfies Record<string, { label: string; patch: LookPatch }>

// ── Validation ───────────────────────────────────────────────────────────────

const decimals = (step: number) => (String(step).split('.')[1] ?? '').length

/** Validate a look patch against the schema. Rejects unknown keys, wrong types and out-of-range
 *  numbers — every problem is listed with its dotted key. Returns the resolved look.
 *  Numbers are rounded to their step's decimals (a slider's float noise never changes the cache key). */
export function validateLook(input: unknown): { ok: true; look: Look } | { ok: false; errors: LookError[] } {
  const errors: LookError[] = []
  const walk = (group: Group, patch: unknown, prefix: string): Record<string, unknown> => {
    const out = defaultsOf(group)
    if (patch === undefined || patch === null) return out
    if (typeof patch !== 'object' || Array.isArray(patch)) { errors.push({ key: prefix.replace(/\.$/, '') || 'look', message: 'must be an object' }); return out }
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      const f = group[k]
      const key = prefix + k
      if (!f) { errors.push({ key, message: 'unknown knob' }); continue }
      if (v === undefined) continue
      if (!('kind' in f)) { out[k] = walk(f as Group, v, `${key}.`); continue }
      const fld = f as Field
      if (fld.kind === 'toggle') {
        if (typeof v !== 'boolean') errors.push({ key, message: `must be true or false, got ${JSON.stringify(v)}` })
        else out[k] = v
      } else {
        if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ key, message: `must be a number between ${fld.min} and ${fld.max}, got ${JSON.stringify(v)}` })
        else if (v < fld.min || v > fld.max) errors.push({ key, message: `must be between ${fld.min} and ${fld.max} ${fld.unit}`.trimEnd() + `, got ${v}` })
        else out[k] = +v.toFixed(Math.max(decimals(fld.step), 2))
      }
    }
    return out
  }
  const look = walk(LOOK_SCHEMA, input, '') as Look
  return errors.length ? { ok: false, errors } : { ok: true, look }
}

/** Schema-ordered JSON of a resolved look, so key order in the input never changes the cache key. */
export function canonicalLook(look: Look): string {
  const order = (group: Group, value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, f] of Object.entries(group)) out[k] = 'kind' in f ? value[k] : order(f as Group, value[k] as Record<string, unknown>)
    return out
  }
  return JSON.stringify(order(LOOK_SCHEMA, look as unknown as Record<string, unknown>))
}

/** Short human summary of what a look does, in chain order — for cards and logs. */
export function describeLook(look: Look): string {
  const parts: string[] = []
  const c = look.cleanup
  if (c.declip.enabled) parts.push('repair clipping')
  if (c.clicks.enabled) parts.push('remove clicks')
  if (c.rumble.enabled) parts.push(`cut rumble < ${c.rumble.frequency} Hz`)
  if (c.hiss.enabled) parts.push(`reduce hiss ${c.hiss.amount} dB`)
  if (look.tone.enabled) parts.push('tone EQ')
  if (look.tone.enabled && look.tone.deesser > 0) parts.push('de-ess')
  if (look.dynamics.enabled) parts.push(`compress ${look.dynamics.ratio}:1`)
  if (look.reverb.enabled) parts.push(`reverb ${look.reverb.decay} s at ${look.reverb.amount} dB`)
  parts.push(look.loudness.enabled ? `level to ${look.loudness.target} LUFS` : 'volume unchanged')
  if (look.fades.in > 0 || look.fades.out > 0) parts.push(`fades ${look.fades.in}/${look.fades.out} s`)
  return parts.join(' · ')
}
