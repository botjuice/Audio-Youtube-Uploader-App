import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { LibraryRecord, Progress, Settings } from '@shared/types'
import { normaliseQuota, remainingUploads } from '@core/quota'
import { encodeVideo } from './ffmpeg'
import { addToPlaylist, uploadVideo } from './google/youtube'
import { scanLibrary, videoPath, writeMarker } from './library'
import { activity } from './log'
import type { LibraryStore } from './store'

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
      const reciters = new Map(snap.reciters.map((r) => [r.folder, r]))
      const queue = ids.map((id) => byId.get(id)).filter((r): r is LibraryRecord => !!r && (r.status === 'ready' || r.status === 'encoded'))

      if (queue.length === 0) { activity.info('Nothing to upload — no ready recordings in the selection.'); return 0 }
      activity.info(`Starting run: ${queue.length} recording(s) queued.`)

      for (const rec of queue) {
        if (signal.aborted) { activity.warn('Run cancelled.'); break }
        const remaining = remainingUploads(ctx.store.quota.get(), ctx.settings.upload.dailyLimit)
        if (remaining <= 0) { activity.warn(`Daily limit of ${ctx.settings.upload.dailyLimit} reached — stopping. Remaining items stay queued.`); break }

        const reciter = reciters.get(rec.reciterFolder)!
        const audio = join(ctx.library, rec.reciterFolder, rec.fileName)
        const mp4 = videoPath(audio)

        // 1 — encode
        if (!rec.hasVideoFile) {
          this.progress({ recordId: rec.id, stage: 'encode', percent: 0 })
          activity.info(`Rendering video for ${rec.fileName}`, rec.id)
          try {
            await encodeVideo({ audio, image: reciter.imagePath!, output: mp4, signal,
              onProgress: (percent) => this.progress({ recordId: rec.id, stage: 'encode', percent }) })
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
        await ctx.store.quota.update((q) => { const n = normaliseQuota(q); q.day = n.day; q.uploads = n.uploads + 1 })
        await ctx.store.records.update((d) => { d[rec.id] = { ...d[rec.id], selected: false, lastError: null } })
        done++
        activity.success(`Uploaded → youtu.be/${videoId}`, rec.id)
        this.emit('changed')

        // 4 — playlists (non-fatal)
        for (const pid of rec.playlists.final) {
          this.progress({ recordId: rec.id, stage: 'playlist', percent: 100, detail: pid })
          try {
            await addToPlaylist(pid, videoId)
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
