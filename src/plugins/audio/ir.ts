/**
 * Synthetic reverb impulse response (IR), generated in code: no bundled files, no licences,
 * deterministic for given knobs (seeded noise), any size.
 *
 * Shape: pre-delay of silence, then decorrelated noise per channel with an exponential decay
 * reaching −60 dB at `decay` seconds; the noise gets darker as it decays (a one-pole low-pass
 * sliding from `tone` down to tone/3, like air and soft surfaces absorbing the top first), a
 * gentle high-pass at 180 Hz keeps the echo from booming, and a 4 ms fade-in avoids a click.
 *
 * Each channel is normalised to unit energy, so convolving the voice with it gives an echo at
 * roughly the voice's own level; the `amount` knob then sets it in dB below the voice.
 */
import type { Look } from './look'

export const IR_RATE = 48_000

export interface IrSpec { decay: number; predelay: number; tone: number; width: number }

export const irSpec = (look: Look): IrSpec => ({ decay: look.reverb.decay, predelay: look.reverb.predelay, tone: look.reverb.tone, width: look.reverb.width })

/** Small, fast, seeded PRNG (mulberry32) → uniform noise in [-1, 1). */
function noise(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

const onePoleCoef = (hz: number) => Math.exp((-2 * Math.PI * hz) / IR_RATE)

/** Two channels of float samples (left, right). */
export function generateIr(spec: IrSpec): [Float32Array, Float32Array] {
  const pre = Math.round((spec.predelay / 1000) * IR_RATE)
  const tail = Math.round(spec.decay * IR_RATE)
  const n = pre + tail
  const k = Math.log(1000) / spec.decay            // amplitude e^{-k t} → −60 dB at t = decay
  const fadeIn = Math.round(0.004 * IR_RATE)
  const hpA = onePoleCoef(180)
  const w = spec.width
  const norm = Math.sqrt(w * w + (1 - w) * (1 - w)) // keep the right channel's power equal to the left's
  const nL = noise(0x5eed01), nR = noise(0x5eed02)
  const out: [Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n)]
  const lp = [0, 0], hpIn = [0, 0], hpOut = [0, 0]
  for (let i = 0; i < tail; i++) {
    const t = i / IR_RATE
    const env = Math.exp(-k * t) * (i < fadeIn ? i / fadeIn : 1)
    const cutoff = spec.tone * Math.pow(1 / 3, Math.min(1, t / spec.decay))
    const a = onePoleCoef(cutoff)
    const l = nL(), r0 = nR()
    const src = [l, (w * r0 + (1 - w) * l) / norm]
    for (let c = 0; c < 2; c++) {
      lp[c] = (1 - a) * src[c]! + a * lp[c]!                       // low-pass, darker over time
      const hp = hpA * (hpOut[c]! + lp[c]! - hpIn[c]!)             // one-pole high-pass at 180 Hz
      hpIn[c] = lp[c]!; hpOut[c] = hp
      out[c]![pre + i] = hp * env
    }
  }
  for (const ch of out) {
    let e = 0
    for (let i = 0; i < n; i++) e += ch[i]! * ch[i]!
    const g = e > 0 ? 1 / Math.sqrt(e) : 0
    for (let i = 0; i < n; i++) ch[i]! *= g
  }
  return out
}

/** Interleaved 32-bit float WAV (format 3), 48 kHz, stereo. */
export function irWav(spec: IrSpec): Buffer {
  const [L, R] = generateIr(spec)
  const n = L.length
  const data = Buffer.alloc(n * 2 * 4)
  for (let i = 0; i < n; i++) { data.writeFloatLE(L[i]!, i * 8); data.writeFloatLE(R[i]!, i * 8 + 4) }
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22)
  h.writeUInt32LE(IR_RATE, 24); h.writeUInt32LE(IR_RATE * 2 * 4, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

/** Correlation between the two channels (1 = identical, 0 = independent) — for tests. */
export function channelCorrelation([L, R]: [Float32Array, Float32Array]): number {
  let lr = 0, ll = 0, rr = 0
  for (let i = 0; i < L.length; i++) { lr += L[i]! * R[i]!; ll += L[i]! * L[i]!; rr += R[i]! * R[i]! }
  return lr / Math.sqrt(ll * rr || 1)
}
