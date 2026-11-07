import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { LibraryRecord, ReasonCode, ReciterInfo, RecordStatus } from '@shared/types'
import { DEFAULT_SURAHS, buildTitle, buildVocabulary, diagnoseStem, reciterKey, resolvePlaylists, tokenize, type SurahDict, type Vocabulary } from '@core/index'
import { AUDIO_EXTS, IMAGE_EXTS, STATE_DIR } from './paths'
import type { LibraryStore, SurahUserLayer } from './store'

export const markerPath = (audioPath: string) => `${audioPath}.uploaded`
export const videoPath = (audioPath: string) => audioPath.replace(/\.[^.]+$/, '.mp4')
const sidecars = (audioPath: string) => [markerPath(audioPath), videoPath(audioPath)]

export interface MarkerData { video_id?: string; title?: string; uploaded_at?: string; manual?: boolean }

export function effectiveSurahs(layer: SurahUserLayer): SurahDict {
  const dict: SurahDict = { ...DEFAULT_SURAHS }
  for (const [k, v] of Object.entries(layer)) { if (v === null) delete dict[k]; else dict[k] = v }
  return dict
}

async function listDir(dir: string) {
  try { return await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
}
const isAudio = (name: string) => AUDIO_EXTS.has(extname(name).toLowerCase())
const isImage = (name: string) => IMAGE_EXTS.has(extname(name).toLowerCase())

/** Which folders count as reciters: any subfolder with audio, plus every registered one (may be empty). */
async function reciterFolders(library: string, store: LibraryStore): Promise<string[]> {
  const registered = new Set(Object.keys(store.reciters.get()))
  const out: string[] = []
  for (const d of await listDir(library)) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === STATE_DIR) continue
    if (registered.has(d.name)) { out.push(d.name); continue }
    const hasAudio = (await listDir(join(library, d.name))).some((e) => e.isFile() && isAudio(e.name))
    if (hasAudio) out.push(d.name)
  }
  return out.sort()
}

export async function currentVocabulary(library: string, store: LibraryStore, excludeFolder?: string): Promise<Vocabulary> {
  const rs = store.reciters.get()
  const folders = (await reciterFolders(library, store)).filter((f) => f !== excludeFolder)
  return buildVocabulary(
    folders.map((folder) => ({ folder, aliases: rs[folder]?.aliases ?? [] })),
    effectiveSurahs(store.surahs.get()),
    store.rules.get().keywords.map((k) => k.name),
  )
}

export interface Move { from: string; to: string; id: string; newId: string }
export interface ScanResult { reciters: ReciterInfo[]; records: LibraryRecord[]; moves: Move[] }
export interface ScanOptions { allowMoves: boolean }

const RECENT_MS = 10_000

export async function scanLibrary(library: string, store: LibraryStore, opts: ScanOptions = { allowMoves: true }): Promise<ScanResult> {
  const surahs = effectiveSurahs(store.surahs.get())
  const { rules } = store.rules.get()
  const recordState = store.records.get()
  const reciterState = store.reciters.get()
  const folders = await reciterFolders(library, store)
  const vocab = await currentVocabulary(library, store)
  const keyToFolder = new Map(folders.map((f) => [reciterKey(f), f]))

  // ── pass 1: auto-file recordings whose name says they belong to another reciter ──
  const moves: Move[] = []
  const conflicts = new Set<string>()
  const listAudio = async (folder: string) =>
    (await listDir(folder ? join(library, folder) : library)).filter((e) => e.isFile() && isAudio(e.name)).map((e) => e.name).sort()
  for (const folder of ['', ...folders]) {
    for (const fileName of await listAudio(folder)) {
      const from = folder ? join(library, folder, fileName) : join(library, fileName)
      const t = tokenize(basename(fileName, extname(fileName)), vocab)
      const home = t.reciter ? keyToFolder.get(t.reciter) : undefined
      if (!home || home === folder) continue
      const id = `${folder}/${fileName}`
      const to = join(library, home, fileName)
      if (await fs.access(to).then(() => true, () => false)) { conflicts.add(id); continue }
      if (!opts.allowMoves) continue
      try {
        const st = await fs.stat(from)
        if (Date.now() - st.mtimeMs < RECENT_MS) continue   // still being copied in
        await moveRecordFiles(from, join(library, home))
        const newId = `${home}/${fileName}`
        await store.records.update((d) => { if (d[id]) { d[newId] = d[id]!; delete d[id] } })
        moves.push({ from, to, id, newId })
      } catch { /* leave it; it will be reported in pass 2 */ }
    }
  }

  // ── pass 2: build records ──
  const reciters: ReciterInfo[] = []
  const records: LibraryRecord[] = []
  const infoByKey = new Map<string, { nameAr: string | null; imagePath: string | null }>()
  const folderMeta: { folder: string; audio: string[]; images: string[] }[] = []
  for (const folder of folders) {
    const entries = (await listDir(join(library, folder))).filter((e) => e.isFile())
    const audio = entries.filter((e) => isAudio(e.name)).map((e) => e.name).sort()
    const images = entries.filter((e) => isImage(e.name)).map((e) => e.name).sort()
    const rs = reciterState[folder] ?? {}
    const nameAr = rs.nameAr?.trim() || null
    const imageName = rs.imageOverride && images.includes(rs.imageOverride) ? rs.imageOverride : images[0] ?? null
    const imagePath = imageName ? join(library, folder, imageName) : null
    infoByKey.set(reciterKey(folder), { nameAr, imagePath })
    folderMeta.push({ folder, audio, images })
  }

  const classify = async (folder: string, fileName: string): Promise<LibraryRecord> => {
    const full = folder ? join(library, folder, fileName) : join(library, fileName)
    const id = `${folder}/${fileName}`
    const ext = extname(fileName), stem = basename(fileName, ext)
    const st = recordState[id] ?? {}
    let sizeBytes = 0, unreadable = false
    try { sizeBytes = (await fs.stat(full)).size } catch { unreadable = true }
    let marker: MarkerData | null = null, markerCorrupt = false
    try { const raw = await fs.readFile(markerPath(full), 'utf8'); try { marker = JSON.parse(raw) as MarkerData } catch { markerCorrupt = true; marker = {} } } catch { /* none */ }
    const hasVideoFile = await fs.access(videoPath(full)).then(() => true, () => false)

    const diag = diagnoseStem(stem, vocab)
    const folderKey = folder ? reciterKey(folder) : null
    const reciterKeyEff = diag.tokens.reciter ?? folderKey
    const home = reciterKeyEff ? infoByKey.get(reciterKeyEff) : undefined
    const nameAr = home?.nameAr ?? null
    const imagePath = home?.imagePath ?? null
    const inWrongFolder = !!reciterKeyEff && reciterKeyEff !== folderKey && keyToFolder.has(reciterKeyEff)

    let status: RecordStatus, reason: ReasonCode | null = null, message: string | null = null
    if (marker) { status = 'uploaded'; reason = markerCorrupt ? 'MARKER_CORRUPT' : 'UPLOADED'; if (markerCorrupt) message = 'Upload marker exists but is unreadable — verify on YouTube or re-mark.' }
    else if (st.skipped) { status = 'skipped'; reason = 'SKIPPED'; message = 'Excluded from uploads by you.' }
    else if (unreadable) { status = 'error'; reason = 'UNREADABLE'; message = 'File cannot be read (permissions or it is in use).' }
    else if (sizeBytes === 0) { status = 'error'; reason = 'ZERO_BYTES'; message = 'File is empty (0 bytes).' }
    else if (conflicts.has(id)) { status = 'error'; reason = 'FILE_CONFLICT'; message = `Belongs in “${keyToFolder.get(reciterKeyEff!)}” but a file with this name already exists there.` }
    else if (!folder && !reciterKeyEff) { status = 'error'; reason = 'NO_RECITER'; message = 'No reciter in the name and the file is not inside a reciter folder — move it into one or add the reciter name.' }
    else if (inWrongFolder) { status = 'error'; reason = 'WRONG_FOLDER'; message = `Belongs to “${keyToFolder.get(reciterKeyEff!)}” — it will be moved there automatically.` }
    else if (diag.status !== 'ready') { status = 'error'; reason = diag.reason; message = diag.message }
    else if (!nameAr) { status = 'error'; reason = 'NO_RECITER_NAME'; message = `Set the Arabic name for “${keyToFolder.get(reciterKeyEff!) ?? folder}” in Reciters — it is needed for the title.` }
    else if (!imagePath) { status = 'error'; reason = 'NO_IMAGE'; message = `No photo in “${folder}” — add a .jpg/.png to use as the video background.` }
    else if (hasVideoFile) { status = 'encoded'; reason = 'ENCODED_NOT_UPLOADED'; message = 'Video already rendered; upload pending.' }
    else status = 'ready'
    if ((status === 'ready' || status === 'encoded') && st.lastError) { reason = 'LAST_ERROR'; message = `Last attempt failed during ${st.lastError.stage}: ${st.lastError.message}` }

    const generated = diag.parsed && nameAr ? buildTitle(nameAr, diag.parsed, surahs) : null
    const title = st.titleOverride?.trim() || marker?.title || generated
    const overrides = st.playlistOverrides ?? { include: [], exclude: [] }
    return {
      id, reciterFolder: folder, reciterKey: reciterKeyEff, fileName, stem, ext, sizeBytes,
      status, reason, message,
      suggestion: diag.suggestion ? `${diag.suggestion}${ext}` : null, fixable: diag.fixable,
      tokens: diag.tokens, parsed: diag.parsed,
      title, titleOverride: st.titleOverride ?? null,
      playlists: resolvePlaylists({ reciter: reciterKeyEff, tokens: diag.tokens }, rules, surahs, overrides),
      playlistOverrides: overrides,
      selected: st.selected ?? false, skipped: st.skipped ?? false,
      videoId: marker?.video_id ?? null, uploadedAt: marker?.uploaded_at ?? null,
      lastError: st.lastError ?? null, hasVideoFile,
      thumbnail: st.thumbnail ?? null,
      allowPlainPhoto: st.allowPlainPhoto ?? false,
    }
  }

  for (const fileName of await listAudio('')) records.push(await classify('', fileName))
  for (const { folder, audio, images } of folderMeta) {
    let uploaded = 0
    for (const fileName of audio) { const r = await classify(folder, fileName); if (r.status === 'uploaded') uploaded++; records.push(r) }
    const rs = reciterState[folder] ?? {}
    const info = infoByKey.get(reciterKey(folder))!
    reciters.push({
      folder, key: reciterKey(folder), nameAr: info.nameAr, aliases: rs.aliases ?? [],
      imagePath: info.imagePath, imageOverride: rs.imageOverride ?? null, images,
      total: audio.length, uploaded,
    })
  }

  const live = new Set(records.map((r) => r.id))
  const stale = Object.keys(recordState).filter((k) => !live.has(k))
  if (stale.length) await store.records.update((d) => { for (const k of stale) delete d[k] })
  return { reciters, records, moves }
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
  for (const [from, to] of [[markerPath(audioPath), markerPath(target)], [videoPath(audioPath), videoPath(target)]]) await fs.rename(from!, to!).catch(() => {})
  return target
}

/** Move audio + sidecars into another folder (same file name). Never overwrites. */
export async function moveRecordFiles(audioPath: string, targetDir: string): Promise<string> {
  const target = join(targetDir, basename(audioPath))
  await fs.access(target).then(() => { throw new Error(`"${basename(audioPath)}" already exists in ${basename(targetDir)}`) }, () => {})
  await fs.mkdir(targetDir, { recursive: true })
  await fs.rename(audioPath, target)
  for (const s of sidecars(audioPath)) await fs.rename(s, join(targetDir, basename(s))).catch(() => {})
  return target
}
