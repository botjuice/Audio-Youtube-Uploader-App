/**
 * Starting points — plain looks, nothing hidden: every preset is just ffmpeg filters with options
 * the user can see and change in the rack. Node-free (the editor imports it).
 */
import type { Look } from './look'

export interface Preset { label: string; desc: string; look: Look }

/** A noise burst decaying 60 dB over `decay` seconds: an impulse response for afir, made by ffmpeg itself. */
const noiseIr = (decay: number, scale: number) => `(random(0)*2-1)*exp(-6.9078*t/${decay})*${scale}`

export const LOOK_PRESETS: Record<string, Preset> = {
  none: { label: 'No effects', desc: 'The recording as it is.', look: { chain: [] } },

  cleanup: {
    label: 'Recitation cleanup',
    desc: 'Click removal, rumble cut below 75 Hz (24 dB/oct), hiss reduction 12 dB with noise tracking, levelled to −14 LUFS. The v1 default.',
    look: {
      chain: [
        { filter: 'adeclick' },
        { filter: 'highpass', options: { frequency: 75, poles: 2 } },
        { filter: 'highpass', options: { frequency: 75, poles: 2 } },
        { filter: 'afftdn', options: { noise_reduction: 12, noise_floor: -42, track_noise: true } },
      ],
      level: { lufs: -14, ceiling: -1.5 },
    },
  },

  springTamer: {
    label: 'Spring tamer',
    desc: 'Ducks only 4.8–5.75 kHz, where the mixer reverb rings longest after each "s" (measured on 62 "s" sounds in Isha Al Imran), by up to ~7 dB for about 0.7 s. The key is that band delayed 200 ms (longer than most "s" sounds) so the "s" itself passes; 120 dB/oct band edges keep 6–9 kHz untouched.',
    look: {
      chain: [{
        filter: 'acrossover', options: { split: '4800 5750', order: '20th' },
        outputs: [
          [],
          [{
            filter: 'sidechaincompress', options: { threshold: 0.00794, ratio: 20, attack: 5, release: 700, knee: 2, detection: 'rms' },
            inputs: [{ kind: 'signal', chain: [{ filter: 'adelay', options: { delays: '200', all: true } }] }],
          }],
          [],
        ],
        merge: { filter: 'amix', options: { inputs: 3, normalize: false } },
      }],
    },
  },

  reverbRoom: {
    label: 'Reverb — room',
    desc: 'Convolution reverb in parallel: the dry voice plus afir with a 0.9 s decaying-noise impulse made by aevalsrc (10 ms pre-delay, darkened above 6 kHz), about 17 dB under the voice. The second amix weight is the reverb amount.',
    look: {
      chain: [{
        filter: 'asplit', options: { outputs: 2 },
        outputs: [
          [],
          [{
            filter: 'afir', options: { gtype: 'none' },
            inputs: [{
              kind: 'generate', filter: 'aevalsrc', options: { exprs: noiseIr(0.9, 0.004), sample_rate: 48000, duration: 0.9 },
              chain: [{ filter: 'lowpass', options: { frequency: 6000 } }, { filter: 'adelay', options: { delays: '10', all: true } }],
            }],
          }],
        ],
        merge: { filter: 'amix', options: { inputs: 2, normalize: false, weights: '1 1' } },
      }],
    },
  },
  reverbHall: {
    label: 'Reverb — hall',
    desc: 'As room, with a 2.2 s decay, 25 ms pre-delay and darker tail (5 kHz).',
    look: {
      chain: [{
        filter: 'asplit', options: { outputs: 2 },
        outputs: [
          [],
          [{
            filter: 'afir', options: { gtype: 'none' },
            inputs: [{
              kind: 'generate', filter: 'aevalsrc', options: { exprs: noiseIr(2.2, 0.0025), sample_rate: 48000, duration: 2.2 },
              chain: [{ filter: 'lowpass', options: { frequency: 5000 } }, { filter: 'adelay', options: { delays: '25', all: true } }],
            }],
          }],
        ],
        merge: { filter: 'amix', options: { inputs: 2, normalize: false, weights: '1 1' } },
      }],
    },
  },
}
