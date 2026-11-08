/**
 * Turns a saved v1 look (the old fixed knobs: cleanup / tone / dynamics / reverb / loudness / limiter /
 * fades) into the v2 rack with the same filters and values v1 used, so a user's tuned look survives the
 * redesign. Node-free.
 *
 * Not carried over exactly:
 *   – fade-out: v1 placed it from the file's length, which a look shared by every recording doesn't know
 *     (fade-in is kept: afade at t = 0);
 *   – reverb width: v1's impulse was stereo; the converted reverb is mono (amount, decay, pre-delay and
 *     tone carry over, the level within about 1 dB);
 *   – the always-on limiter when levelling was off (v2 limits only as part of levelling).
 */
import type { Look, Step } from './look'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

const V1_DEFAULTS = {
  cleanup: { declip: { enabled: false }, clicks: { enabled: true }, rumble: { enabled: true, frequency: 75 }, hiss: { enabled: true, amount: 12 } },
  tone: { enabled: false, mud: { gain: -1.5, frequency: 250 }, presence: { gain: 2.5, frequency: 3000 }, air: { gain: 0, frequency: 9000 }, deesser: 0 },
  dynamics: { enabled: false, threshold: -20, ratio: 2, attack: 20, release: 250 },
  reverb: { enabled: false, amount: -16, decay: 1.2, predelay: 15, tone: 5500, width: 0.8 },
  loudness: { enabled: true, target: -14 },
  limiter: { ceiling: -1.5 },
  fades: { in: 0.5, out: 1.5 },
}

function merge(a: Obj, b: unknown): Obj {
  const out: Obj = { ...a }
  if (!isObj(b)) return out
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k] as Obj, v) : v
  return out
}

/** True for a look saved by plugin v1 (no `chain`, old section names). */
export function isV1Look(x: unknown): boolean {
  return isObj(x) && !('chain' in x) && ['cleanup', 'tone', 'dynamics', 'reverb', 'loudness', 'limiter', 'fades'].some((k) => k in x)
}

export function lookFromV1(patch: unknown): Look {
  const v = merge(V1_DEFAULTS as unknown as Obj, patch) as unknown as typeof V1_DEFAULTS
  const chain: Step[] = []
  const c = v.cleanup
  if (c.declip.enabled) chain.push({ filter: 'adeclip' })
  if (c.clicks.enabled) chain.push({ filter: 'adeclick' })
  if (c.rumble.enabled) for (let i = 0; i < 2; i++) chain.push({ filter: 'highpass', options: { frequency: c.rumble.frequency, poles: 2 } })
  if (c.hiss.enabled) chain.push({ filter: 'afftdn', options: { noise_reduction: c.hiss.amount, noise_floor: -42, track_noise: true } })
  const t = v.tone
  if (t.enabled) {
    if (t.mud.gain !== 0) chain.push({ filter: 'equalizer', options: { frequency: t.mud.frequency, width_type: 'q', width: 1, gain: t.mud.gain } })
    if (t.presence.gain !== 0) chain.push({ filter: 'equalizer', options: { frequency: t.presence.frequency, width_type: 'q', width: 1.2, gain: t.presence.gain } })
    if (t.air.gain !== 0) chain.push({ filter: 'treble', options: { frequency: t.air.frequency, gain: t.air.gain } })
    if (t.deesser > 0) chain.push({ filter: 'deesser', options: { i: t.deesser, m: 0.5, f: 0.5 } })
  }
  const d = v.dynamics
  if (d.enabled) chain.push({ filter: 'acompressor', options: { threshold: Math.pow(10, d.threshold / 20), ratio: d.ratio, attack: d.attack, release: d.release, makeup: 1 } })
  const r = v.reverb
  if (r.enabled) {
    // v1's impulse had unit energy and its wet level was amount − (1.9 + 0.8·decay) dB; a noise burst
    // decaying 60 dB over `decay` s at 48 kHz has energy ≈ 1158·decay, hence the scale below
    const scale = Math.pow(10, (r.amount - (1.9 + 0.8 * r.decay)) / 20) / Math.sqrt(1158 * r.decay)
    chain.push({
      filter: 'asplit', options: { outputs: 2 },
      outputs: [[], [{
        filter: 'afir', options: { gtype: 'none' },
        inputs: [{
          kind: 'generate', filter: 'aevalsrc', options: { exprs: `(random(0)*2-1)*exp(-6.9078*t/${r.decay})*${Number(scale.toPrecision(4))}`, sample_rate: 48000, duration: r.decay },
          chain: [{ filter: 'lowpass', options: { frequency: r.tone } }, ...(r.predelay > 0 ? [{ filter: 'adelay', options: { delays: String(r.predelay), all: true } }] : [])],
        }],
      }]],
      merge: { filter: 'amix', options: { inputs: 2, normalize: false } },
    })
  }
  if (v.fades.in > 0) chain.push({ filter: 'afade', options: { type: 'in', start_time: 0, duration: v.fades.in } })
  return { chain, ...(v.loudness.enabled ? { level: { lufs: v.loudness.target, ceiling: v.limiter.ceiling } } : {}) }
}
