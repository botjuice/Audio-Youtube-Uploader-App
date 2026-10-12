import { FolderOpen, ImageOff, Users } from 'lucide-react'
import { useState } from 'react'
import type { ReciterInfo } from '@shared/types'
import { Badge, Button, Card, Empty, Field, Input, Select } from '@/components/ui'
import { useStore } from '@/store'

export default function Reciters() {
  const reciters = useStore((s) => s.library.reciters)
  const settings = useStore((s) => s.settings)
  return (
    <div className="h-full overflow-auto">
      <div className="drag h-13 flex items-center px-6 border-b border-border"><h1 className="font-semibold">Reciters</h1></div>
      <div className="p-6 max-w-5xl">
        {reciters.length === 0 ? (
          <Empty icon={<Users size={28} />} title="No reciter folders found"
            hint={<>Create a folder per reciter inside <code>{settings?.libraryPath}</code>, drop in one photo and the audio files, then Rescan from the Library.</>} />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">{reciters.map((r) => <ReciterCard key={r.folder} r={r} libraryPath={settings?.libraryPath ?? ''} />)}</div>
        )}
      </div>
    </div>
  )
}

function ReciterCard({ r, libraryPath }: { r: ReciterInfo; libraryPath: string }) {
  const call = useStore((s) => s.call)
  const [nameAr, setNameAr] = useState(r.nameAr ?? '')
  const [prefix, setPrefix] = useState(r.prefixOverride ?? '')
  const save = (patch: Parameters<typeof window.api.patchReciter>[1]) => void call('reciter', () => window.api.patchReciter(r.folder, patch))

  return (
    <Card title={r.folder} subtitle={`${r.uploaded} of ${r.total} uploaded`}
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
        <Field label="Filename prefix" hint={<>Files must start with this. Auto: <code>{r.folder.replace(/\s+/g, '')}</code> — only change if your files use something else.</>}>
          <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} onBlur={() => prefix.trim() !== (r.prefixOverride ?? '') && save({ prefixOverride: prefix.trim() || null })}
            placeholder={r.folder.replace(/\s+/g, '')} className="font-mono text-xs" />
        </Field>
      </div>
    </Card>
  )
}
