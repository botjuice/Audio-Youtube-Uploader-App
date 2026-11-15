/**
 * The audio stage of an upload: measure the recording, steer it to its rule's target (Auto-set's loop), render the
 * whole recording with those settings, and hand the pipeline the processed file. Nothing here uploads.
 *
 * It never passes off a bad result as a good one: if the settings cannot bring the recording near the target, or
 * anything fails, the caller gets the reason and holds the upload (the user can allow the original audio instead).
 */
import { toLook } from '../core/audio-modules'
import { TERRIBLE_TONE_DB, type AudioRulesState } from '../core/audio-rules'
import { defaultModules } from '../core/audio-modules'
import { discard, processAudio, type AudioHost } from '../plugins/audio/index'
import { audioDir, rackLevel } from './audio'
import { autoSet } from './audio-autoset'
import { recordingFacts } from './audio-facts'
import { targetFor } from './audio-rules'
import { ffmpegPath } from './ffmpeg'
import { activity } from './log'

export type AudioStageResult =
  | { ok: true; audio: string; /** 'original' when nothing was processed */ key: string; via: 'reciter' | 'default' | 'built-in' | 'off'; toneAfter?: number; cleanup: () => Promise<void> }
  | { ok: false; reason: 'AUDIO_POOR' | 'AUDIO_FAILED' | 'CANCELLED'; message: string }

export async function prepareUploadAudio(o: {
  library: string; state: AudioRulesState; recordId: string; reciterKey: string | null; rel: string; audioPath: string
  signal?: AbortSignal; onProgress?: (percent: number, detail: string) => void
}): Promise<AudioStageResult> {
  const original: AudioStageResult = { ok: true, audio: o.audioPath, key: 'original', via: 'off', cleanup: async () => {} }
  if (!o.state.applyToUploads) return original
  const bin = ffmpegPath()
  if (!bin) return { ok: false, reason: 'AUDIO_FAILED', message: 'ffmpeg is not available on this computer.' }
  const aim = targetFor(o.state, o.reciterKey)
  if (!aim) return { ok: false, reason: 'AUDIO_FAILED', message: 'There is no audio rule to apply and the built-in one cannot be used with this version’s measurements.' }
  try {
    o.onProgress?.(0, 'Measuring')
    const facts = await recordingFacts(o.library, { rel: o.rel, path: o.audioPath })
    if (o.signal?.aborted) return { ok: false, reason: 'CANCELLED', message: 'Cancelled' }
    o.onProgress?.(15, 'Choosing settings')
    let step = 0
    const r = await autoSet(bin, o.audioPath, defaultModules(), { ...facts, target: aim.target },
      (text) => o.onProgress?.(Math.min(60, 20 + 10 * step++), text.replace(/…$/, '')), o.signal, { rackLevel: (look) => rackLevel(o.audioPath, look) })
    const summary = r.report.map((x) => `${x.what.split(':')[0]} ${x.before} → ${x.after}`).join(', ')
    if (r.toneAfter > TERRIBLE_TONE_DB) {
      return { ok: false, reason: 'AUDIO_POOR', message: `The audio rule could not bring this recording near its target: the tone is still ${r.toneAfter.toFixed(1)} dB away (under 1 dB is normal, over ${TERRIBLE_TONE_DB} dB is held). ${summary}.` }
    }
    o.onProgress?.(65, 'Rendering')
    const host: AudioHost = { outputDir: audioDir(o.library), ffmpegPath: bin, ...(o.signal ? { signal: o.signal } : {}), log: (level, message) => { if (level === 'error') activity.error(message, o.recordId); else if (level === 'warn') activity.warn(message, o.recordId) }, onProgress: (p) => o.onProgress?.(65 + Math.round(p * 0.35), 'Rendering') }
    // the loop has just measured the whole recording through these settings: hand the render its gain so it does not measure again
    const look = toLook(r.modules)
    const rack = look.level ? await rackLevel(o.audioPath, look).catch(() => null) : null
    const known = rack && look.level && rack.rate ? { gainDb: look.level.lufs - rack.lufs, rate: rack.rate } : {}
    const out = await processAudio({ audioPath: o.audioPath, look, ...known }, host)
    if (!out.ok) return out.reason === 'CANCELLED' ? { ok: false, reason: 'CANCELLED', message: 'Cancelled' } : { ok: false, reason: 'AUDIO_FAILED', message: `${out.reason}: ${out.message}` }
    activity.info(`Audio processed (${aim.via === 'reciter' ? 'this reciter’s rule' : aim.via === 'default' ? 'the default rule' : 'the built-in rule'}): ${summary}`, o.recordId)
    return { ok: true, audio: out.file, key: out.cacheKey, via: aim.via, toneAfter: r.toneAfter, cleanup: () => discard(out.file) }
  } catch (e) {
    if (o.signal?.aborted) return { ok: false, reason: 'CANCELLED', message: 'Cancelled' }
    return { ok: false, reason: 'AUDIO_FAILED', message: e instanceof Error ? e.message : String(e) }
  }
}
