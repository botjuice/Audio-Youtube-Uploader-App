import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, FolderOpen, ImageOff, Layers, Plus, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReciterInfo, ThumbnailVariant, TokenValidation } from '@shared/types'
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, Select } from '@/components/ui'
import { useStyledPreview } from '@/lib/preview'
import { useBusy, useStore } from '@/store'

export default function Reciters() {
  const reciters = useStore((s) => s.library.reciters)
  const settings = useStore((s) => s.settings)
  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center px-6 border-b border-border"><h1 className="font-semibold">Reciters</h1></div>
      <div className="p-6 max-w-5xl space-y-4">
        <AddReciter />
        {reciters.length === 0 ? (
          <Empty icon={<Users size={28} />} title="No reciter folders yet"
            hint={<>Add one above, or create a folder per reciter inside <code>{settings?.libraryPath}</code> and drop recordings in.</>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">{reciters.map((r) => <ReciterCard key={r.folder} r={r} libraryPath={settings?.libraryPath ?? ''} />)}</div>
        )}
      </div>
    </div>
  )
}

function AddReciter() {
  const library = useStore((s) => s.library)
  const call = useStore((s) => s.call)
  const notify = useStore((s) => s.notify)
  const busy = useBusy('addReciter')
  const [name, setName] = useState(''); const [nameAr, setNameAr] = useState(''); const [playlistId, setPlaylistId] = useState('')
  const [check, setCheck] = useState<TokenValidation | null>(null)
  useEffect(() => {
    if (!name.trim()) { setCheck(null); return }
    let live = true
    const t = setTimeout(() => void window.api.validateToken('reciter', name).then((v) => { if (live) setCheck(v) }), 250)
    return () => { live = false; clearTimeout(t) }
  }, [name])
  const willMove = name.trim() ? library.records.filter((r) => r.tokens.leftovers.some((l) => l.toLowerCase() === name.trim().toLowerCase())).length : 0
  const add = () => void call('addReciter', async () => {
    const res = await window.api.addReciter({ name, nameAr, ...(playlistId ? { playlistId } : {}) })
    notify('success', `Added “${res.folder}”${res.moved ? ` — moved ${res.moved} recording${res.moved === 1 ? '' : 's'}` : ''}`)
    setName(''); setNameAr(''); setPlaylistId('')
  })
  return (
    <Card title="Add a reciter" subtitle="Creates the folder. Every recording whose name contains this reciter moves into it — now and whenever new files appear.">
      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-start">
        <div>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name as written in filenames, e.g. Mishary" />
          {check?.error && <div className="text-xs text-err mt-1">{check.error}</div>}
          {check?.ok && check.warning && <div className="text-xs text-warn mt-1">{check.warning}</div>}
          {check?.ok && willMove > 0 && <div className="text-xs text-ok mt-1">{willMove} recording{willMove === 1 ? '' : 's'} will move here</div>}
        </div>
        <Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="اسم القارئ" />
        <Select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)}>
          <option value="">Playlist (optional)</option>
          {library.playlists.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
        </Select>
        <Button variant="primary" onClick={add} disabled={busy || !check?.ok || !nameAr.trim()}><Plus size={14} /> Add</Button>
      </div>
    </Card>
  )
}

function ReciterCard({ r, libraryPath }: { r: ReciterInfo; libraryPath: string }) {
  const call = useStore((s) => s.call)
  const settings = useStore((s) => s.settings)
  const library = useStore((s) => s.library)
  const thumbsOn = !!settings?.thumbnails.enabled
  // Every look this reciter's videos can get: recomputed when the thumbnail or playlist rules change.
  const [variants, setVariants] = useState<ThumbnailVariant[] | null>(null)
  const [showAll, setShowAll] = useState(false)
  const rulesKey = JSON.stringify([library.thumbnailRules, library.rules, library.playlists.map((p) => [p.id, p.title])])
  useEffect(() => {
    if (!thumbsOn || !r.nameAr || !r.imagePath) { setVariants(null); return }
    let live = true
    void window.api.listReciterVariants(r.folder).then((v) => { if (live) setVariants(v) }).catch(() => { if (live) setVariants([]) })
    return () => { live = false }
  }, [r.folder, r.imagePath, r.nameAr, thumbsOn, rulesKey])
  const [nameAr, setNameAr] = useState(r.nameAr ?? '')
  const [aliases, setAliases] = useState(r.aliases.join(', '))
  useEffect(() => { setNameAr(r.nameAr ?? ''); setAliases(r.aliases.join(', ')) }, [r.nameAr, r.aliases])
  const save = (patch: Parameters<typeof window.api.patchReciter>[1]) => void call('reciter', () => window.api.patchReciter(r.folder, patch))

  return (
    <Card title={r.folder} subtitle={`${r.uploaded} of ${r.total} uploaded · matched in filenames as “${r.key}”${r.aliases.length ? ` or ${r.aliases.map((a) => `“${a}”`).join(', ')}` : ''}`}
      actions={<Button size="sm" variant="ghost" onClick={() => void window.api.showInFolder(`${libraryPath}/${r.folder}`)}><FolderOpen size={14} /></Button>}>
      <div className="space-y-3">
        <Field label="Arabic name" hint="Used at the start of every title">
          <Input dir="rtl" value={nameAr} onChange={(e) => setNameAr(e.target.value)} onBlur={() => nameAr.trim() !== (r.nameAr ?? '') && save({ nameAr: nameAr.trim() || null })}
            placeholder="اسم القارئ" className={!r.nameAr ? 'border-err/50' : ''} />
        </Field>
        <Field label="Photo" hint="Background of every video">
          {r.images.length === 0 ? <Badge tone="err"><ImageOff size={12} /> No image in folder</Badge> : (
            <Select value={r.imageOverride ?? r.images[0] ?? ''} onChange={(e) => save({ imageOverride: e.target.value })} className="w-full">
              {r.images.map((i) => <option key={i} value={i}>{i}</option>)}
            </Select>
          )}
        </Field>
        {thumbsOn && (
          <Field label="Thumbnail preview" hint={variants?.[0] ? `The everyday look from the thumbnail rules · sample: ${variants[0].when}, today` : 'How this reciter\'s thumbnails will look with the current photo, name and thumbnail rules'}>
            {!r.nameAr || !r.imagePath ? <div className="text-xs text-muted">Set the Arabic name and a photo to see a preview.</div>
              : !variants?.[0] ? <div className="aspect-video rounded-lg bg-surface-2 animate-pulse" />
              : <VariantPreview v={variants[0]} />}
            {variants && variants.length > 0 && (
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted">
                  {variants.length === 1 ? 'No other rule changes this reciter\'s thumbnails.'
                    : `${variants.length - 1} other look${variants.length === 2 ? '' : 's'} can apply, depending on the recording.`}
                </span>
                {variants.length > 1 && <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}><Layers size={14} /> View all {variants.length} looks</Button>}
              </div>
            )}
            {variants && <VariantsModal open={showAll} onClose={() => setShowAll(false)} folder={r.folder} variants={variants} />}
          </Field>
        )}
        <Field label="Other spellings" hint="Comma-separated. Filenames using any of these also belong to this reciter.">
          <Input value={aliases} onChange={(e) => setAliases(e.target.value)}
            onBlur={() => { const next = aliases.split(',').map((a) => a.trim()).filter(Boolean); if (next.join('|') !== r.aliases.join('|')) save({ aliases: next }) }}
            placeholder="e.g. Mousa, AAM" />
        </Field>
      </div>
    </Card>
  )
}

/** One rendered look (same renderer and cache as the rule editor). */
function VariantPreview({ v, className }: { v: ThumbnailVariant; className?: string }) {
  const { result, rendering } = useStyledPreview(v.sample, v.style ?? {}, v.photo, true, 0)
  if (!result || (rendering && !result.ok)) return <div className={clsx('aspect-video rounded-lg bg-surface-2 animate-pulse', className)} />
  if (!result.ok) return <div className={clsx('aspect-video rounded-lg border border-border bg-surface-2 flex items-center justify-center p-4 text-xs text-warn text-center', className)}>Can't render: {result.message}</div>
  return <img src={result.dataUrl} alt={v.title} className={clsx('w-full aspect-video rounded-lg border border-border object-cover', rendering && 'opacity-60', className)} />
}

/** Slideshow of every look the reciter's videos can get. All slides render up front; arrows and ←/→ move between them. */
function VariantsModal({ open, onClose, folder, variants }: { open: boolean; onClose: () => void; folder: string; variants: ThumbnailVariant[] }) {
  const [i, setI] = useState(0)
  const n = variants.length
  const go = (d: number) => setI((x) => (x + d + n) % n)
  useEffect(() => { if (open) setI(0) }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') go(-1); else if (e.key === 'ArrowRight') go(1) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, n])  // eslint-disable-line react-hooks/exhaustive-deps
  const cur = variants[Math.min(i, n - 1)]
  if (!cur) return null
  return (
    <Modal open={open} onClose={onClose} title={`Thumbnail looks · ${folder}`} width="max-w-3xl">
      <div className="flex items-center gap-2">
        <IconButton label="Previous look" onClick={() => go(-1)} disabled={n < 2} className="shrink-0"><ChevronLeft size={18} /></IconButton>
        <div className="flex-1 min-w-0">
          {variants.map((v, j) => <VariantPreview key={v.id} v={v} className={j === i ? '' : 'hidden'} />)}
        </div>
        <IconButton label="Next look" onClick={() => go(1)} disabled={n < 2} className="shrink-0"><ChevronRight size={18} /></IconButton>
      </div>
      <div className="mt-3 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium truncate">{cur.title}</div>
          <div className="text-xs text-muted truncate" title={cur.look}>Look: {cur.look}</div>
          <div className="text-xs text-muted truncate" title={cur.when}>Sample: {cur.when}</div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          <span className="text-xs text-muted tabular-nums">{i + 1} of {n}</span>
          <div className="flex gap-1">
            {variants.map((v, j) => <button key={v.id} aria-label={v.title} onClick={() => setI(j)} className={clsx('h-1.5 w-1.5 rounded-full transition-colors no-drag', j === i ? 'bg-accent' : 'bg-border hover:bg-muted')} />)}
          </div>
        </div>
      </div>
    </Modal>
  )
}
