import { clsx } from 'clsx'
import { Check, ExternalLink, FolderOpen, Pencil, RotateCcw, Sparkles, X, Plus, CircleSlash, CircleCheck, Tag, BookOpen, UserPlus, Image as ImageIcon, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LibraryRecord, ThumbnailPreview } from '@shared/types'
import { Badge, Button, Checkbox, Chip, IconButton, Input, Modal, Select } from '@/components/ui'
import { statusMeta, fmtBytes, fmtRel, parseVideoId } from '@/lib/format'
import { describeRule } from '@core/rules'
import { describeLook, resolveThumbnailLook } from '@core/thumb-rules'
import { useStore } from '@/store'

export function RecordDetail({ record: r, onClose }: { record: LibraryRecord; onClose: () => void }) {
  const library = useStore((s) => s.library)
  const settings = useStore((s) => s.settings)
  const call = useStore((s) => s.call)
  const select = useStore((s) => s.select)
  const notify = useStore((s) => s.notify)

  const [name, setName] = useState(r.fileName)
  const [editingName, setEditingName] = useState(false)
  const [title, setTitle] = useState(r.titleOverride ?? '')
  const [editingTitle, setEditingTitle] = useState(false)
  const [markOpen, setMarkOpen] = useState(false)
  const [markId, setMarkId] = useState('')
  const [addPl, setAddPl] = useState('')
  const [leftoverAction, setLeftoverAction] = useState<{ word: string; kind: 'surah' | 'keyword' | 'reciter' } | null>(null)

  useEffect(() => { setName(r.fileName); setEditingName(false); setTitle(r.titleOverride ?? ''); setEditingTitle(false); setMarkOpen(false); setMarkId('') }, [r.id, r.fileName, r.titleOverride])

  const meta = statusMeta(r)
  const plName = (id: string) => library.playlists.find((p) => p.id === id)?.title ?? id
  const candidates = [...new Set([...r.playlists.auto, ...r.playlists.final])]
  const addable = library.playlists.filter((p) => !r.playlists.final.includes(p.id))

  const rename = () => call('rename', async () => { const id = await window.api.renameRecord(r.id, name); select(id); setEditingName(false) }, { success: 'Renamed' })
  const applyFix = () => call('fix', async () => { const id = await window.api.applyFix(r.id); select(id) }, { success: 'Renamed' })
  const saveTitle = () => call('title', () => window.api.patchRecord(r.id, { titleOverride: title.trim() || null }).then(() => setEditingTitle(false)))
  const togglePlaylist = (id: string) => {
    const o = { include: r.playlistOverrides.include.filter((x) => x !== id), exclude: r.playlistOverrides.exclude.filter((x) => x !== id) }
    const inFinal = r.playlists.final.includes(id), isAuto = r.playlists.auto.includes(id)
    if (inFinal && isAuto) o.exclude.push(id)
    if (!inFinal && !isAuto) o.include.push(id)
    void call('pl', () => window.api.patchRecord(r.id, { playlistOverrides: o }))
  }
  const markUploaded = () => {
    const vid = markId.trim() ? parseVideoId(markId) : undefined
    if (markId.trim() && !vid) return notify('error', 'That does not look like a YouTube video URL or id')
    void call('mark', () => window.api.markUploaded(r.id, vid ?? undefined), { success: 'Marked as uploaded' })
  }
  const absPath = settings?.libraryPath ? `${settings.libraryPath}/${r.reciterFolder}/${r.fileName}` : null

  return (
    <aside className="w-[380px] shrink-0 border-l border-border bg-surface/60 flex flex-col min-h-0">
      <div className="flex items-center justify-between px-4 h-13 border-b border-border shrink-0">
        <div className="flex items-center gap-2"><Badge tone={meta.tone}>{meta.label}</Badge><span className="text-xs text-muted">{fmtBytes(r.sizeBytes)}</span></div>
        <IconButton label="Close" onClick={onClose}><X size={16} /></IconButton>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-5">
        {/* why */}
        {(r.message || r.lastError) && (
          <section className={clsx('rounded-lg border p-3 text-xs space-y-2', r.status === 'error' && !r.fixable ? 'border-err/30 bg-err/6' : r.fixable ? 'border-warn/30 bg-warn/6' : 'border-border bg-surface')}>
            {r.message && <div>{r.message}</div>}
            {r.lastError && r.reason !== 'LAST_ERROR' && <div className="text-muted">Last attempt ({r.lastError.stage}, {fmtRel(r.lastError.at)}): {r.lastError.message}</div>}
            {r.suggestion && (
              <div className="pt-1 space-y-1">
                <div className="text-[11px] text-muted">{r.tokens.leftovers.length ? 'Remove the unrecognised part(s)' : 'Clean the date'} →</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 truncate rounded bg-surface-2 px-1.5 py-1 text-[11px]">{r.suggestion}</code>
                  <Button size="sm" variant="primary" onClick={applyFix}><Sparkles size={12} /> Rename</Button>
                </div>
              </div>
            )}
            {r.tokens.leftovers.length > 0 && (
              <div className="pt-1">
                <div className="text-[11px] text-muted mb-1">…or teach the app what these mean:</div>
                <div className="flex flex-wrap gap-1.5">
                  {r.tokens.leftovers.map((w, i) => (
                    <span key={i} className="inline-flex items-center rounded-full border border-err/40 bg-err/8 pl-2 text-xs">
                      <span className="font-mono">{w}</span>
                      <button className="ml-1 px-1.5 h-6 hover:text-accent" title="Add as surah spelling" onClick={() => setLeftoverAction({ word: w, kind: 'surah' })}><BookOpen size={12} /></button>
                      <button className="px-1.5 h-6 hover:text-accent" title="Add as keyword → playlist" onClick={() => setLeftoverAction({ word: w, kind: 'keyword' })}><Tag size={12} /></button>
                      <button className="px-1.5 h-6 pr-2 hover:text-accent" title="Add as reciter (creates folder)" onClick={() => setLeftoverAction({ word: w, kind: 'reciter' })}><UserPlus size={12} /></button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>
        )}

        {/* filename */}
        <Section label="Filename" action={!editingName && <IconButton label="Rename" onClick={() => setEditingName(true)}><Pencil size={13} /></IconButton>}>
          {editingName ? (
            <div className="flex gap-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditingName(false) }} />
              <Button size="sm" variant="primary" onClick={rename}><Check size={13} /></Button>
            </div>
          ) : <code className="block break-all text-xs">{r.fileName}</code>}
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
            {r.reciterKey && <Badge tone="accent">{library.reciters.find((x) => x.key === r.reciterKey)?.folder ?? r.reciterKey}</Badge>}
            {r.tokens.prayer ? <Badge>{r.tokens.prayer}</Badge> : <Badge tone="err">no prayer</Badge>}
            {r.tokens.surahs.length ? r.tokens.surahs.map((s, i) => <Badge key={i} tone="info">{s}</Badge>) : <Badge tone="err">no surah</Badge>}
            {r.tokens.date ? <Badge>{r.tokens.date}{r.tokens.dateDirty ? ' ✎' : ''}</Badge> : <Badge tone="err">no date</Badge>}
            {r.tokens.keywords.map((k) => <Badge key={k} tone="warn"><Tag size={10} /> {k}</Badge>)}
          </div>
        </Section>

        {/* title */}
        <Section label="YouTube title" action={!editingTitle && <IconButton label="Override title" onClick={() => setEditingTitle(true)}><Pencil size={13} /></IconButton>}>
          {editingTitle ? (
            <div className="space-y-2">
              <Input dir="rtl" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leave empty to use the generated title" autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') setEditingTitle(false) }} />
              <div className="flex gap-2 justify-end"><Button size="sm" onClick={() => setEditingTitle(false)}>Cancel</Button><Button size="sm" variant="primary" onClick={saveTitle}>Save</Button></div>
            </div>
          ) : (
            <div dir="rtl" className="text-[14px] leading-6">{r.title ?? <span className="text-muted" dir="ltr">— set the reciter's Arabic name to generate a title</span>}</div>
          )}
          {r.titleOverride && !editingTitle && (
            <button className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-muted hover:text-text" onClick={() => void call('title', () => window.api.patchRecord(r.id, { titleOverride: null }))}>
              <RotateCcw size={11} /> Custom title — click to revert to generated
            </button>
          )}
        </Section>

        {/* thumbnail */}
        <ThumbnailSection record={r} />

        {/* playlists */}
        <Section label="Playlists" hint={r.status === 'uploaded' ? 'Already uploaded — changes here affect future uploads only' : 'Click a playlist to include or exclude it for this recording'}>
          <div className="flex flex-wrap gap-1.5">
            {candidates.length === 0 && <span className="text-xs text-muted">No playlist rules match. Add one in Playlists, or add one below.</span>}
            {candidates.map((id) => {
              const viaIds = r.playlists.via?.[id] ?? []
              const why = viaIds.length ? 'via: ' + viaIds.map((rid) => describeRule(library.rules.find((x) => x.id === rid) ?? { conditions: [] })).join(' | ') : 'added manually for this recording'
              return <Chip key={id} active={r.playlists.final.includes(id)} onClick={() => togglePlaylist(id)} title={why}>{plName(id)}</Chip>
            })}
          </div>
          {addable.length > 0 && (
            <div className="mt-2 flex gap-2">
              <Select value={addPl} onChange={(e) => setAddPl(e.target.value)} className="flex-1 h-7.5 text-xs">
                <option value="">Add a playlist for this recording…</option>
                {addable.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
              </Select>
              <Button size="sm" disabled={!addPl} onClick={() => { togglePlaylist(addPl); setAddPl('') }}><Plus size={13} /></Button>
            </div>
          )}
        </Section>

        {/* uploaded info */}
        {r.status === 'uploaded' && (
          <Section label="Upload">
            <div className="text-xs text-muted">{r.uploadedAt ? `Uploaded ${fmtRel(r.uploadedAt)}` : 'Marked as uploaded'}{r.videoId ? '' : ' · no video id recorded'}</div>
            {r.videoId && <Button size="sm" className="mt-2" onClick={() => void window.api.openExternal(`https://youtu.be/${r.videoId}`)}><ExternalLink size={13} /> Open on YouTube</Button>}
          </Section>
        )}
      </div>

      {/* actions */}
      <div className="border-t border-border p-3 space-y-2 shrink-0">
        {markOpen && (
          <div className="flex gap-2">
            <Input value={markId} onChange={(e) => setMarkId(e.target.value)} placeholder="YouTube URL or id (optional)" className="text-xs" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') markUploaded() }} />
            <Button size="sm" variant="primary" onClick={markUploaded}>Mark</Button>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {r.status === 'uploaded'
            ? <Button size="sm" onClick={() => void call('mark', () => window.api.markNotUploaded(r.id), { success: 'Marked as not uploaded' })}><RotateCcw size={13} /> Mark not uploaded</Button>
            : <Button size="sm" onClick={() => setMarkOpen((v) => !v)}><CircleCheck size={13} /> Mark as uploaded</Button>}
          {r.status !== 'uploaded' && (
            <Button size="sm" onClick={() => void call('skip', () => window.api.patchRecord(r.id, { skipped: !r.skipped, selected: false }))}>
              <CircleSlash size={13} /> {r.skipped ? 'Include again' : 'Skip this file'}
            </Button>
          )}
          {absPath && <Button size="sm" onClick={() => void window.api.showInFolder(absPath)}><FolderOpen size={13} /> Show in folder</Button>}
        </div>
      </div>
      {leftoverAction && <LeftoverModal record={r} action={leftoverAction} onClose={() => setLeftoverAction(null)} />}
    </aside>
  )
}

function LeftoverModal({ record, action, onClose }: { record: LibraryRecord; action: { word: string; kind: 'surah' | 'keyword' | 'reciter' }; onClose: () => void }) {
  const library = useStore((s) => s.library)
  const call = useStore((s) => s.call)
  const [arabic, setArabic] = useState('')
  const [name, setName] = useState(action.word)
  const [playlists, setPlaylists] = useState<string[]>([])
  const [check, setCheck] = useState<{ ok: boolean; error?: string; warning?: string } | null>(null)
  useEffect(() => {
    if (action.kind === 'surah') return
    let live = true
    void window.api.validateToken(action.kind, name).then((v) => { if (live) setCheck(v) })
    return () => { live = false }
  }, [name, action.kind])
  const toggle = (id: string) => setPlaylists((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const submit = () => {
    if (action.kind === 'surah') return void call('leftover', () => window.api.setSurah(action.word, arabic).then(onClose), { success: `“${action.word}” now means ${arabic}` })
    if (action.kind === 'keyword') return void call('leftover', async () => {
      await window.api.setKeywords([...library.keywords, { name }])
      if (playlists.length) await window.api.setRules([...library.rules, ...playlists.map((pid) => ({ id: crypto.randomUUID(), playlistId: pid, enabled: true, conditions: [{ kind: 'keyword' as const, value: name, negate: false }] }))])
      onClose()
    }, { success: `Keyword “${name}” added${playlists.length ? ` with ${playlists.length} rule${playlists.length === 1 ? '' : 's'}` : ''}` })
    return void call('leftover', () => window.api.addReciter({ name, nameAr: arabic, ...(playlists[0] ? { playlistId: playlists[0] } : {}) }).then(onClose), { success: `Reciter “${name}” added` })
  }
  const titles = { surah: `“${action.word}” is a surah`, keyword: `“${action.word}” is a keyword`, reciter: `“${action.word}” is a reciter` }
  return (
    <Modal open onClose={onClose} title={titles[action.kind]}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit} disabled={(action.kind !== 'surah' && (!check?.ok || !name.trim())) || (action.kind !== 'keyword' && !arabic.trim())}>Save</Button></>}>
      <div className="space-y-3 text-[13px]">
        {action.kind !== 'surah' && (
          <div>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name as written in filenames" />
            {check?.error && <div className="text-xs text-err mt-1">{check.error}</div>}
            {check?.warning && <div className="text-xs text-warn mt-1">{check.warning}</div>}
          </div>
        )}
        {action.kind !== 'keyword' && <Input dir="rtl" value={arabic} onChange={(e) => setArabic(e.target.value)} placeholder={action.kind === 'surah' ? 'الاسم بالعربية' : 'اسم القارئ'} autoFocus />}
        {action.kind !== 'surah' && (
          <div>
            <div className="text-xs text-muted mb-1">{action.kind === 'keyword' ? 'Also create a rule “Keyword is …” for these playlists (optional):' : 'Playlist for this reciter (optional):'}</div>
            <div className="flex flex-wrap gap-1.5">
              {library.playlists.length === 0 && <span className="text-xs text-muted">No playlists loaded yet (Playlists → Refresh).</span>}
              {library.playlists.map((p) => <Chip key={p.id} active={playlists.includes(p.id)} onClick={() => action.kind === 'reciter' ? setPlaylists([p.id]) : toggle(p.id)}>{p.title}</Chip>)}
            </div>
          </div>
        )}
        {action.kind === 'reciter' && <p className="text-xs text-muted">A folder “{name}” will be created and every recording naming this reciter — including “{record.fileName}” — will move into it.</p>}
        {action.kind === 'surah' && <p className="text-xs text-muted">Every file using this spelling will parse again automatically.</p>}
      </div>
    </Modal>
  )
}

function ThumbnailSection({ record: r }: { record: LibraryRecord }) {
  const settings = useStore((s) => s.settings)
  const library = useStore((s) => s.library)
  const call = useStore((s) => s.call)
  const lookName = describeLook(resolveThumbnailLook({ reciter: r.reciterKey, tokens: r.tokens, playlists: r.playlists.final }, library.thumbnailRules), (id) => library.playlists.find((p) => p.id === id)?.title ?? id)
  const rulesKey = JSON.stringify(library.thumbnailRules)
  const [preview, setPreview] = useState<ThumbnailPreview | null>(null)
  const [full, setFull] = useState(false)
  const enabled = !!settings?.thumbnails.enabled
  const canPreview = enabled && !!r.parsed
  useEffect(() => {
    setPreview(null)
    if (!canPreview) return
    let live = true
    void window.api.previewThumbnail(r.id).then((p) => { if (live) setPreview(p) }).catch((e) => { if (live) setPreview({ ok: false, reason: 'RENDER_FAILED', message: String(e) }) })
    return () => { live = false }
  }, [r.id, r.fileName, r.titleOverride, canPreview, settings?.thumbnails.sheikhPrefix, rulesKey, JSON.stringify(r.playlists.final)])
  if (!enabled) return null
  const t = r.thumbnail
  return (
    <Section label="Thumbnail" hint={<>{r.status === 'uploaded' ? (t?.set ? 'Set on YouTube' : t?.setError ? 'Not set on YouTube' : 'Uploaded before thumbnails existed') : 'Rendered on upload; also used as the video frame'}{lookName && <> · look: <b>{lookName}</b></>}</>}>
      {!r.parsed ? <div className="text-xs text-muted">Fix the filename first.</div>
        : !preview ? <div className="h-[135px] rounded-lg bg-surface-2 animate-pulse" />
        : preview.ok ? (
          <button className="block w-full rounded-lg overflow-hidden border border-border" onClick={() => setFull(true)} title="Click to enlarge">
            <img src={preview.dataUrl} alt="thumbnail" className="w-full aspect-video object-cover" />
          </button>
        ) : (
          <div className={clsx('rounded-lg border p-2 text-xs', r.allowPlainPhoto ? 'border-warn/30 bg-warn/6' : 'border-err/40 bg-err/6')}>
            <div className="flex items-center gap-1.5 font-medium"><ImageIcon size={12} /> Thumbnail can't be rendered ({preview.reason})</div>
            <div className="mt-0.5">{preview.message}</div>
            <div className="text-muted mt-1">{r.allowPlainPhoto ? 'You allowed the plain reciter photo, so this recording uploads without a custom thumbnail.' : 'This recording is held back from uploading until the cause is fixed (in Thumbnail rules, Reciters or the filename) or you allow the plain photo below.'}</div>
          </div>
        )}
      {r.status !== 'uploaded' && (preview?.ok === false || r.allowPlainPhoto || r.lastError?.stage === 'thumbnail') && (
        <label className="mt-2 flex items-start gap-2 rounded-lg border border-border bg-surface-2/40 p-2 text-xs cursor-pointer">
          <Checkbox checked={r.allowPlainPhoto} onChange={(v) => void call('plain', () => window.api.patchRecord(r.id, { allowPlainPhoto: v }))} />
          <span><b>Upload with the plain photo anyway</b><span className="text-muted"> — the video frame becomes the reciter photo and no custom thumbnail is set. If the thumbnail renders fine at upload time it is used regardless.</span></span>
        </label>
      )}
      {t?.setError && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/6 p-2 text-xs">
          <div className="flex-1"><b>Thumbnail not set:</b> {t.setError}</div>
          {r.videoId && <Button size="sm" onClick={() => void call('retryThumb', () => window.api.retryThumbnail(r.id), { success: 'Thumbnail set on YouTube' })}><RefreshCw size={12} /> Retry</Button>}
        </div>
      )}
      {full && preview?.ok && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8 no-drag" onClick={() => setFull(false)}>
          <img src={preview.dataUrl} alt="thumbnail" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </Section>
  )
}

function Section({ label, hint, action, children }: { label: string; hint?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between mb-1.5">
        <div><div className="text-[11px] uppercase tracking-wide text-muted font-semibold">{label}</div>{hint && <div className="text-[11px] text-muted/80">{hint}</div>}</div>
        {action}
      </div>
      {children}
    </section>
  )
}
