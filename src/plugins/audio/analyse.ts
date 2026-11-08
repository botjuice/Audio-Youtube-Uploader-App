/**
 * What a recording sounds like, in numbers. Four decodes run in parallel (each a fraction of a
 * second per minute of audio): loudness + true peak, the hiss band, the rumble band, hot samples.
 *
 * Hiss/rumble are reported as measurements relative to the voice, without "noisy" verdicts:
 * recitation has almost no pauses, so there is no true noise-only moment to measure, and we have
 * no ground truth for where "too noisy" starts. Verdicts are given only where they are certain.
 */
import type { AudioAnalysis } from './types'
import { parseEbur, parseMetadataValues, percentile, probe, runFfmpeg } from './ffmpeg'

const KEY = 'lavfi.astats.Overall.RMS_level'
/** RMS of every 100 ms block of one frequency band, printed to stdout. */
const bandGraph = (band: string) => `${band},asetnsamples=n=4800,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=mode=print:key=${KEY}:file=-`

/** Clipping = this share (%) of samples above −0.5 dBFS. Why not astats' "Peak count" or "Flat factor": on
 *  decoded AAC (all our recordings) both are useless — peak count is 2 on every file and the flat tops are
 *  smeared by the codec. Measured 2026-11-08: the 53 real recordings 0–0.015 %, a hard-clipped tone after
 *  AAC 50 %. No really clipped recording was available, so the threshold sits well clear of both. */
export const CLIP_HOT_PCT = 0.1
const HOT = 0.944   // −0.5 dBFS

export async function analyseFile(bin: string, file: string, signal?: AbortSignal): Promise<AudioAnalysis> {
  const info = await probe(bin, file)
  const input = ['-hide_banner', '-i', file]
  const [main, hf, lf, hot] = await Promise.all([
    runFfmpeg(bin, [...input, '-af', 'aresample=48000,ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { signal }),
    runFfmpeg(bin, ['-v', 'error', '-i', file, '-af', bandGraph('aresample=48000,highpass=f=4000:poles=2,highpass=f=4000:poles=2'), '-f', 'null', '-'], { signal, captureStdout: true }),
    runFfmpeg(bin, ['-v', 'error', '-i', file, '-af', bandGraph('aresample=48000,lowpass=f=60:poles=2,lowpass=f=60:poles=2'), '-f', 'null', '-'], { signal, captureStdout: true }),
    // 1 where |sample| > HOT, else 0 → its RMS² is the share of hot samples
    runFfmpeg(bin, ['-hide_banner', '-i', file, '-af', `aeval='gt(abs(val(0))\\,${HOT})',astats=measure_perchannel=none:measure_overall=RMS_level`, '-f', 'null', '-'], { signal }),
  ])
  const ebur = parseEbur(main.stderr) ?? { lufs: -Infinity, lra: 0, truePeak: -Infinity }
  const lufs = ebur.lufs
  const hissDb = round1(percentile(parseMetadataValues(hf.stdout, KEY), 0.05) - lufs)
  const rumbleDb = round1(percentile(parseMetadataValues(lf.stdout, KEY), 0.5) - lufs)
  const hotRms = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(hot.stderr)?.[1]
  const hotSamplesPct = hotRms && hotRms !== '-inf' ? +(Math.pow(10, Number(hotRms) / 10) * 100).toFixed(4) : 0
  const clipped = hotSamplesPct > CLIP_HOT_PCT

  const hints: string[] = []
  if (!Number.isFinite(lufs) || lufs < -60) hints.push('Silent or nearly silent recording.')
  else {
    if (clipped) hints.push('Clipped in places (the waveform is flattened at the top) — turn on "Repair clipping".')
    if (lufs < -20) hints.push(`Quiet recording (${lufs.toFixed(1)} LUFS): levelling raises it by about ${(-14 - lufs).toFixed(0)} dB, which raises its background noise too.`)
    if (lufs > -10) hints.push(`Very loud recording (${lufs.toFixed(1)} LUFS): it will be turned down.`)
  }
  return {
    durationSec: info.durationSec, sampleRate: info.sampleRate, channels: info.channels,
    lufs: round1(lufs), lra: round1(ebur.lra), truePeak: round1(ebur.truePeak),
    hotSamplesPct,
    hissDb, rumbleDb, clipped, hints,
  }
}

const round1 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x)
