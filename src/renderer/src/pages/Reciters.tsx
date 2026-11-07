import { FolderOpen, ImageOff, Plus, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ReciterInfo, ThumbnailPreview, TokenValidation } from '@shared/types'
import { Badge, Button, Card, Empty, Field, Input, Select } from '@/components/ui'
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
  const [preview, setPreview] = useState<ThumbnailPreview | null>(null)
  const thumbsOn = !!settings?.thumbnails.enabled
  useEffect(() => {
    setPreview(null)
    if (!thumbsOn || !r.nameAr || !r.imagePath) return
    let live = true
    void window.api.previewReciterThumbnail(r.folder).then((p) => { if (live) setPreview(p) }).catch(() => { if (live) setPreview({ ok: false, message: 'Preview failed' }) })
    return () => { live = false }
  }, [r.folder, r.imagePath, r.nameAr, thumbsOn, settings?.thumbnails.sheikhPrefix])
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
          <Field label="Thumbnail preview" hint="How this reciter's thumbnails will look with the current photo, name and thumbnail rules (sample: Jumuah, al-Kahf, today)">
            {!r.nameAr || !r.imagePath ? <div className="text-xs text-muted">Set the Arabic name and a photo to see a preview.</div>
              : !preview ? <div className="aspect-video rounded-lg bg-surface-2 animate-pulse" />
              : preview.ok ? <img src={preview.dataUrl} alt="preview" className="w-full aspect-video rounded-lg border border-border object-cover" />
              : <div className="text-xs text-warn">Can't render: {preview.message}</div>}
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
