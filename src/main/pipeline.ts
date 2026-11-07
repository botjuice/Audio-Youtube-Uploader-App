import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { LibraryRecord, Progress, Settings } from '@shared/types'
import { PLAYLIST_ADD_COST_UNITS, THUMBNAIL_COST_UNITS, UPLOAD_COST_UNITS, addQuota, remainingUploads } from '@core/quota'
import { encodeVideo } from './ffmpeg'
import { addToPlaylist, setThumbnail, uploadVideo } from './google/youtube'
import { effectiveSurahs, scanLibrary, videoPath, writeMarker } from './library'
import { activity } from './log'
import type { LibraryStore } from './store'
import { buildThumbnailJob, renderJob, resolveRulePhoto, styleForRecord } from './thumbnails'
import { describeLook } from '@core/thumb-rules'

export interface PipelineContext {
  library: string
  store: LibraryStore
  settings: Settings
}

export class Pipeline extends EventEmitter {
  private abort: AbortController | null = null
  get busy(): boolean { return this.abort !== null }

  cancel(): void { this.abort?.abort() }

  private progress(p: Progress | null) { this.emit('progress', p) }

  /** Process the given records (by id) in order, stopping at the daily quota. Returns # uploaded. */
  async run(ids: string[], ctx: PipelineContext): Promise<number> {
    if (this.busy) throw new Error('An upload run is already in progress')
    this.abort = new AbortController()
    const signal = this.abort.signal
    let done = 0
    try {
      const snap = await scanLibrary(ctx.library, ctx.store)
      const byId = new Map(snap.records.map((r) => [r.id, r]))
      const reciters = new Map(snap.reciters.map((r) => [r.key, r]))
      const queue = ids.map((id) => byId.get(id)).filter((r): r is LibraryRecord => !!r && (r.status === 'ready' || r.status === 'encoded'))

      if (queue.length === 0) { activity.info('Nothing to upload — no ready recordings in the selection.'); return 0 }
      activity.info(`Starting run: ${queue.length} recording(s) queued.`)

      for (const rec of queue) {
        if (signal.aborted) { activity.warn('Run cancelled.'); break }
        const remaining = remainingUploads(ctx.store.quota.get(), ctx.settings.upload.dailyLimit, ctx.settings.upload.dailyUnits)
        if (remaining <= 0) { activity.warn(`Daily limit reached (${ctx.settings.upload.dailyLimit} uploads / ${ctx.settings.upload.dailyUnits} API units) — stopping. Remaining items stay queued.`); break }

        const reciter = reciters.get(rec.reciterKey ?? '')!
        const audio = join(ctx.library, rec.reciterFolder, rec.fileName)
        const mp4 = videoPath(audio)

        // 0 — thumbnail (never blocks: on any failure we fall back to the plain photo)
        let frame: string = reciter.imagePath!
        let frameKey = 'photo'
        let thumbFile: string | null = null
        if (ctx.settings.thumbnails.enabled) {
          this.progress({ recordId: rec.id, stage: 'thumbnail', percent: 0 })
          const surahs = effectiveSurahs(ctx.store.surahs.get())
          const look = styleForRecord(rec, ctx.store.thumbRules.get().rules, surahs)
          const built = buildThumbnailJob(rec, reciter, surahs, ctx.settings.thumbnails, look.style, await resolveRulePhoto(ctx.library, look.photo, rec.id))
          if (look.style) activity.info(`Thumbnail look: ${describeLook(look)}`, rec.id)
          const result = built.ok ? await renderJob(built.job, ctx.library, rec.id) : built
          if (result.ok) {
            frame = result.frame; frameKey = result.cacheKey; thumbFile = result.thumbnail
            await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], thumbnail: { ok: true, key: result.cacheKey, set: d[rec.id]?.thumbnail?.set, at: new Date().toISOString() } } })
          } else {
            activity.warn(`Thumbnail not rendered for ${rec.fileName} (${result.reason}): ${result.message} — using the plain photo.`, rec.id)
            await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], thumbnail: { ok: false, reason: result.reason, message: result.message, at: new Date().toISOString() } } })
          }
        }

        // 1 — encode (also re-encode when the existing mp4 was made from a different frame)
        const prevKey = ctx.store.records.get()[rec.id]?.videoKey
        const needsEncode = !rec.hasVideoFile || (ctx.settings.thumbnails.enabled && frameKey !== 'photo' && prevKey !== frameKey)
        if (needsEncode) {
          this.progress({ recordId: rec.id, stage: 'encode', percent: 0 })
          activity.info(`${rec.hasVideoFile ? 'Re-rendering' : 'Rendering'} video for ${rec.fileName}${frameKey !== 'photo' ? ' (designed frame, 1080p)' : ''}`, rec.id)
          try {
            await encodeVideo({ audio, image: frame, output: mp4, signal, size: frameKey !== 'photo' ? '1080p' : '720p',
              onProgress: (percent) => this.progress({ recordId: rec.id, stage: 'encode', percent }) })
            await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], videoKey: frameKey } })
          } catch (e) {
            await this.fail(ctx, rec, 'encode', e); continue
          }
        }

        // 2 — upload
        this.progress({ recordId: rec.id, stage: 'upload', percent: 0 })
        activity.info(`Uploading “${rec.title}”`, rec.id)
        let videoId: string
        try {
          videoId = await uploadVideo(mp4, {
            title: rec.title!, description: ctx.settings.upload.description, tags: ctx.settings.upload.tags,
            categoryId: ctx.settings.upload.categoryId, privacy: ctx.settings.upload.privacy, madeForKids: ctx.settings.upload.madeForKids,
          }, { signal, onProgress: (percent) => this.progress({ recordId: rec.id, stage: 'upload', percent }) })
        } catch (e) {
          await this.fail(ctx, rec, 'upload', e)
          if (/quota/i.test(String(e))) { activity.error('Quota exhausted — stopping the run.'); break }
          continue
        }

        // 3 — mark FIRST so a playlist failure can never cause a duplicate upload
        await writeMarker(audio, { video_id: videoId, title: rec.title!, uploaded_at: new Date().toISOString() })
        await ctx.store.quota.update((q) => addQuota(q, { uploads: 1, units: UPLOAD_COST_UNITS }))
        await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], selected: false, lastError: null } })
        done++
        activity.success(`Uploaded → youtu.be/${videoId}`, rec.id)
        this.emit('changed')

        // 4 — custom thumbnail (non-fatal, 50 units)
        if (thumbFile) {
          this.progress({ recordId: rec.id, stage: 'thumbnail', percent: 100 })
          try {
            await setThumbnail(videoId, thumbFile)
            await ctx.store.quota.update((q) => addQuota(q, { units: THUMBNAIL_COST_UNITS }))
            await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], thumbnail: { ...(d[rec.id]?.thumbnail ?? { ok: true, at: '' }), ok: true, set: true, setError: undefined, at: new Date().toISOString() } } })
            activity.info('Thumbnail set on YouTube', rec.id)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            activity.warn(`Thumbnail not set: ${msg}`, rec.id)
            await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], thumbnail: { ...(d[rec.id]?.thumbnail ?? { ok: true, at: '' }), set: false, setError: msg, at: new Date().toISOString() }, lastError: { stage: 'thumbnail', message: msg, at: new Date().toISOString() } } })
          }
        }

        // 5 — playlists (non-fatal, 50 units each)
        for (const pid of rec.playlists.final) {
          this.progress({ recordId: rec.id, stage: 'playlist', percent: 100, detail: pid })
          try {
            await addToPlaylist(pid, videoId)
            await ctx.store.quota.update((q) => addQuota(q, { units: PLAYLIST_ADD_COST_UNITS }))
            activity.info(`Added to playlist ${snapPlaylistName(ctx, pid)}`, rec.id)
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            activity.warn(`Could not add to playlist ${snapPlaylistName(ctx, pid)}: ${msg}`, rec.id)
            await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], lastError: { stage: 'playlist', message: msg, at: new Date().toISOString() } } })
          }
        }
        this.emit('changed')
      }
      activity.info(`Run finished — ${done} uploaded.`)
      return done
    } finally {
      this.abort = null
      this.progress(null)
      this.emit('changed')
      this.emit('done', done)
    }
  }

  private async fail(ctx: PipelineContext, rec: LibraryRecord, stage: 'encode' | 'upload', e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    activity.error(`${stage === 'encode' ? 'Render' : 'Upload'} failed for ${rec.fileName}: ${message}`, rec.id)
    await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], lastError: { stage, message, at: new Date().toISOString() } } })
    this.emit('changed')
  }
}

function snapPlaylistName(ctx: PipelineContext, id: string): string {
  return ctx.store.playlists.get().items.find((p) => p.id === id)?.title ?? id
}
