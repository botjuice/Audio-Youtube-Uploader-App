import { clsx } from 'clsx'
import { Check, ExternalLink, FolderOpen, Pencil, RotateCcw, Sparkles, X, Plus, CircleSlash, CircleCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { LibraryRecord } from '@shared/types'
import { Badge, Button, Chip, IconButton, Input, Select } from '@/components/ui'
import { STATUS_META, fmtBytes, fmtRel, parseVideoId } from '@/lib/format'
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

  useEffect(() => { setName(r.fileName); setEditingName(false); setTitle(r.titleOverride ?? ''); setEditingTitle(false); setMarkOpen(false); setMarkId('') }, [r.id, r.fileName, r.titleOverride])

  const meta = STATUS_META[r.status]
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
          <section className={clsx('rounded-lg border p-3 text-xs space-y-2', r.status === 'error' ? 'border-err/30 bg-err/6' : r.status === 'fix' ? 'border-warn/30 bg-warn/6' : 'border-border bg-surface')}>
            {r.message && <div>{r.message}</div>}
            {r.lastError && r.reason !== 'LAST_ERROR' && <div className="text-muted">Last attempt ({r.lastError.stage}, {fmtRel(r.lastError.at)}): {r.lastError.message}</div>}
            {r.suggestion && (
              <div className="flex items-center gap-2 pt-1">
                <code className="flex-1 truncate rounded bg-surface-2 px-1.5 py-1 text-[11px]">{r.suggestion}</code>
                <Button size="sm" variant="primary" onClick={applyFix}><Sparkles size={12} /> Apply</Button>
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
          {r.parsed && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              <Badge>{r.parsed.prayer}</Badge>{r.parsed.surahs.map((s) => <Badge key={s} tone="info">{s}</Badge>)}<Badge>{r.parsed.date}</Badge>
            </div>
          )}
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

        {/* playlists */}
        <Section label="Playlists" hint={r.status === 'uploaded' ? 'Already uploaded — changes here affect future uploads only' : 'Click a playlist to include or exclude it for this recording'}>
          <div className="flex flex-wrap gap-1.5">
            {candidates.length === 0 && <span className="text-xs text-muted">No playlist rules match. Add one in Playlists, or add one below.</span>}
            {candidates.map((id) => <Chip key={id} active={r.playlists.final.includes(id)} onClick={() => togglePlaylist(id)} title={id}>{plName(id)}</Chip>)}
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
    </aside>
  )
}

function Section({ label, hint, action, children }: { label: string; hint?: string; action?: React.ReactNode; children: React.ReactNode }) {
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
