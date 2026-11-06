import { Image as ImageIcon, Plus, X, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SurahOption, ThumbnailPreview } from '@shared/types'
import { PRAYERS } from '@core/prayers'
import { Badge, Button, Card, Field, Select, Spinner, Switch } from '@/components/ui'
import { useBusy, useStore } from '@/store'

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export default function Thumbnails() {
  const library = useStore((s) => s.library)
  const settings = useStore((s) => s.settings)
  const call = useStore((s) => s.call)
  const busy = useBusy('playground')
  const [surahOptions, setSurahOptions] = useState<SurahOption[]>([])
  const [folder, setFolder] = useState(library.reciters[0]?.folder ?? '')
  const [surahs, setSurahs] = useState<string[]>(['الفاتحة'])
  const [prayer, setPrayer] = useState('Isha')
  const [date, setDate] = useState(todayIso())
  const [sheikh, setSheikh] = useState(settings?.thumbnails.sheikhPrefix ?? true)
  const [result, setResult] = useState<ThumbnailPreview | null>(null)
  const [full, setFull] = useState(false)

  useEffect(() => { void window.api.listSurahOptions().then(setSurahOptions) }, [])
  useEffect(() => { if (!folder && library.reciters[0]) setFolder(library.reciters[0].folder) }, [library.reciters, folder])

  const reciter = library.reciters.find((r) => r.folder === folder)
  const render = () => void call('playground', async () => {
    setResult(await window.api.renderPlayground({ folder, surahsAr: surahs, prayer, date, sheikhPrefix: sheikh }))
  })
  // first render once everything is loaded
  useEffect(() => { if (folder && surahOptions.length && !result && !busy) render() }, [folder, surahOptions.length]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center gap-3 px-6 border-b border-border">
        <h1 className="font-semibold">Thumbnails</h1>
        <span className="text-xs text-muted">Try the exact frame your uploads will get, before anything is uploaded.</span>
        {settings && !settings.thumbnails.enabled && <Badge tone="warn">Thumbnails are off in Settings — uploads use the plain photo</Badge>}
      </div>
      <div className="grid grid-cols-[320px_minmax(0,1fr)] gap-5 p-6 max-w-7xl">
        <Card title="Recording" subtitle="Photo and Arabic name come from the reciter folder, exactly as in an upload.">
          <div className="space-y-3">
            <Field label="Reciter">
              <Select value={folder} onChange={(e) => setFolder(e.target.value)} className="w-full">
                {library.reciters.length === 0 && <option value="">(no reciter folders)</option>}
                {library.reciters.map((r) => <option key={r.folder} value={r.folder}>{r.folder}{r.nameAr ? ` · ${r.nameAr}` : ' · ⚠ no Arabic name'}</option>)}
              </Select>
              {reciter && !reciter.imagePath && <div className="text-xs text-err mt-1">No photo in this folder.</div>}
            </Field>
            <Field label={`Surah${surahs.length > 1 ? 's' : ''}`} hint="Up to 3, in the order they appear on the frame">
              <div className="space-y-1.5">
                {surahs.map((s, i) => (
                  <div key={i} className="flex gap-1.5">
                    <Select value={s} onChange={(e) => setSurahs(surahs.map((x, j) => (j === i ? e.target.value : x)))} className="flex-1">
                      {surahOptions.map((o) => <option key={o.n} value={o.ar}>{o.n}. {o.ar}{o.label ? ` — ${o.label}` : ''}</option>)}
                    </Select>
                    <Button size="sm" variant="ghost" disabled={surahs.length === 1} onClick={() => setSurahs(surahs.filter((_, j) => j !== i))}><X size={13} /></Button>
                  </div>
                ))}
                {surahs.length < 3 && <Button size="sm" variant="subtle" onClick={() => setSurahs([...surahs, surahOptions[0]?.ar ?? 'الفاتحة'])}><Plus size={13} /> Add surah</Button>}
              </div>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Prayer">
                <Select value={prayer} onChange={(e) => setPrayer(e.target.value)} className="w-full">{PRAYERS.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
              </Field>
              <Field label="Date" hint="Shown as Hijri">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8.5 w-full rounded-lg border border-border bg-surface px-2 text-[13px] no-drag" />
              </Field>
            </div>
            <Field inline label="Prefix «الشيخ»" hint={settings && sheikh !== settings.thumbnails.sheikhPrefix ? 'Differs from Settings — uploads use the Settings value' : undefined}>
              <Switch checked={sheikh} onChange={setSheikh} />
            </Field>
            <Button variant="primary" className="w-full" onClick={render} disabled={busy || !folder}>{busy ? <Spinner /> : <Sparkles size={14} />} Render</Button>
          </div>
        </Card>

        <Card title="Frame · 1920×1080" subtitle={result?.ok ? `${result.cached ? 'From cache' : 'Rendered'}${result.ms !== undefined ? ` in ${result.ms} ms` : ''} · this exact image becomes the video; the YouTube thumbnail is the same at 1280×720` : 'Click Render'}
          actions={result?.ok && <Button size="sm" variant="ghost" onClick={() => setFull(true)}>View full size</Button>}>
          {!result ? <div className="aspect-video rounded-lg bg-surface-2 flex items-center justify-center text-muted"><ImageIcon size={28} /></div>
            : result.ok ? (
              <button className="block w-full rounded-lg overflow-hidden border border-border" onClick={() => setFull(true)} title="Click to view full size">
                <img src={result.frameDataUrl ?? result.dataUrl} alt="frame" className="w-full aspect-video object-cover" />
              </button>
            ) : (
              <div className="rounded-lg border border-warn/30 bg-warn/6 p-3 text-sm">
                <div className="font-medium">Can't render ({result.reason})</div>
                <div className="text-muted text-xs mt-1">{result.message}</div>
              </div>
            )}
        </Card>
      </div>
      {full && result?.ok && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6 no-drag" onClick={() => setFull(false)}>
          <img src={result.frameDataUrl ?? result.dataUrl} alt="frame" className="max-h-full max-w-full rounded-lg shadow-2xl" />
        </div>
      )}
    </div>
  )
}
