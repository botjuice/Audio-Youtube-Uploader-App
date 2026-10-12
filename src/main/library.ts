import { promises as fs } from 'node:fs'
import { extname, join, basename } from 'node:path'
import type { LibraryRecord, ReciterInfo, RecordStatus, ReasonCode } from '@shared/types'
import { DEFAULT_SURAHS, type SurahDict, buildTitle, diagnoseStem, prefixFromFolder, resolvePlaylists } from '@core/index'
import { AUDIO_EXTS, IMAGE_EXTS, STATE_DIR } from './paths'
import type { LibraryStore, SurahUserLayer } from './store'

export const markerPath = (audioPath: string) => `${audioPath}.uploaded`
export const videoPath = (audioPath: string) => audioPath.replace(/\.[^.]+$/, '.mp4')

export interface MarkerData { video_id?: string; title?: string; uploaded_at?: string; manual?: boolean }

export function effectiveSurahs(layer: SurahUserLayer): SurahDict {
  const dict: SurahDict = { ...DEFAULT_SURAHS }
  for (const [k, v] of Object.entries(layer)) {
    if (v === null) delete dict[k]
    else dict[k] = v
  }
  return dict
}

async function listDir(dir: string) {
  try { return await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
}

export interface ScanResult { reciters: ReciterInfo[]; records: LibraryRecord[] }

export async function scanLibrary(library: string, store: LibraryStore): Promise<ScanResult> {
  const surahs = effectiveSurahs(store.surahs.get())
  const rules = store.rules.get().rules
  const recordState = store.records.get()
  const reciterState = store.reciters.get()

  const reciters: ReciterInfo[] = []
  const records: LibraryRecord[] = []

  for (const d of await listDir(library)) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === STATE_DIR) continue
    const folder = join(library, d.name)
    const entries = (await listDir(folder)).filter((e) => e.isFile())
    const audio = entries.filter((e) => AUDIO_EXTS.has(extname(e.name).toLowerCase())).map((e) => e.name).sort()
    if (audio.length === 0) continue

    const images = entries.filter((e) => IMAGE_EXTS.has(extname(e.name).toLowerCase())).map((e) => e.name).sort()
    const rs = reciterState[d.name] ?? {}
    const nameAr = rs.nameAr?.trim() || null
    const prefix = rs.prefixOverride?.trim() || prefixFromFolder(d.name)
    const imageName = (rs.imageOverride && images.includes(rs.imageOverride)) ? rs.imageOverride : images[0] ?? null
    const imagePath = imageName ? join(folder, imageName) : null

    let uploaded = 0
    for (const fileName of audio) {
      const full = join(folder, fileName)
      const id = `${d.name}/${fileName}`
      const ext = extname(fileName)
      const stem = basename(fileName, ext)
      const st = recordState[id] ?? {}

      let sizeBytes = 0
      let unreadable = false
      try { sizeBytes = (await fs.stat(full)).size } catch { unreadable = true }

      // marker
      let marker: MarkerData | null = null
      let markerCorrupt = false
      try {
        const raw = await fs.readFile(markerPath(full), 'utf8')
        try { marker = JSON.parse(raw) as MarkerData } catch { markerCorrupt = true; marker = {} }
      } catch { /* no marker */ }

      const hasVideoFile = await fs.access(videoPath(full)).then(() => true, () => false)

      const diag = diagnoseStem(stem, prefix, surahs)
      const parsed = diag.parsed ?? null

      let status: RecordStatus
      let reason: ReasonCode | null = null
      let message: string | null = null
      let suggestion: string | null = diag.suggestion ? `${diag.suggestion}${ext}` : null

      if (marker) {
        status = 'uploaded'; uploaded++
        if (markerCorrupt) { reason = 'MARKER_CORRUPT'; message = 'Upload marker exists but is unreadable — verify on YouTube or re-mark.' }
        else reason = 'UPLOADED'
      } else if (st.skipped) {
        status = 'skipped'; reason = 'SKIPPED'; message = 'Excluded from uploads by you.'
      } else if (unreadable) {
        status = 'error'; reason = 'UNREADABLE'; message = 'File cannot be read (permissions or it is in use).'
      } else if (sizeBytes === 0) {
        status = 'error'; reason = 'ZERO_BYTES'; message = 'File is empty (0 bytes).'
      } else if (diag.status !== 'ready') {
        status = diag.status; reason = diag.reason; message = diag.message
      } else if (!nameAr) {
        status = 'error'; reason = 'NO_RECITER_NAME'; message = `Set the Arabic name for "${d.name}" in Reciters — it is needed for the title.`
      } else if (!imagePath) {
        status = 'error'; reason = 'NO_IMAGE'; message = `No photo in "${d.name}" — add a .jpg/.png to use as the video background.`
      } else if (hasVideoFile) {
        status = 'encoded'; reason = 'ENCODED_NOT_UPLOADED'; message = 'Video already rendered; upload pending.'
      } else {
        status = 'ready'
      }
      if (status === 'ready' || status === 'encoded') {
        if (st.lastError) { reason = 'LAST_ERROR'; message = `Last attempt failed during ${st.lastError.stage}: ${st.lastError.message}` }
      }

      const generated = parsed && nameAr ? buildTitle(nameAr, parsed, surahs) : null
      const title = st.titleOverride?.trim() || marker?.title || generated

      records.push({
        id, reciterFolder: d.name, fileName, stem, ext, sizeBytes,
        status, reason, message, suggestion, parsed,
        title, titleOverride: st.titleOverride ?? null,
        playlists: resolvePlaylists({ reciterFolder: d.name, stem, parsed }, rules, st.playlistOverrides),
        playlistOverrides: st.playlistOverrides ?? { include: [], exclude: [] },
        selected: st.selected ?? false,
        skipped: st.skipped ?? false,
        videoId: marker?.video_id ?? null,
        uploadedAt: marker?.uploaded_at ?? null,
        lastError: st.lastError ?? null,
        hasVideoFile,
      })
    }

    reciters.push({
      folder: d.name, nameAr, prefix, prefixOverride: rs.prefixOverride ?? null,
      imagePath, imageOverride: rs.imageOverride ?? null, images,
      total: audio.length, uploaded,
    })
  }

  // prune state for files that no longer exist (keep it tidy, log nothing noisy)
  const live = new Set(records.map((r) => r.id))
  const stale = Object.keys(recordState).filter((k) => !live.has(k))
  if (stale.length) await store.records.update((d) => { for (const k of stale) delete d[k] })

  return { reciters, records }
}

export async function writeMarker(audioPath: string, data: MarkerData): Promise<void> {
  await fs.writeFile(markerPath(audioPath), JSON.stringify(data, null, 2), 'utf8')
}
export async function removeMarker(audioPath: string): Promise<void> {
  await fs.rm(markerPath(audioPath), { force: true })
}

/** Rename audio + its sidecars (marker, rendered video) together. Returns the new absolute path. */
export async function renameRecordFiles(audioPath: string, newFileName: string): Promise<string> {
  const dir = audioPath.slice(0, audioPath.length - basename(audioPath).length)
  const target = join(dir, newFileName)
  if (target === audioPath) return audioPath
  await fs.access(target).then(() => { throw new Error(`"${newFileName}" already exists`) }, () => {})
  await fs.rename(audioPath, target)
  for (const [from, to] of [[markerPath(audioPath), markerPath(target)], [videoPath(audioPath), videoPath(target)]]) {
    await fs.rename(from!, to!).catch(() => {})
  }
  return target
}
