import { Download, RefreshCw, Sparkles, AlertTriangle } from 'lucide-react'
import { Button, ProgressBar, Spinner } from './ui'
import { useBusy, useStore } from '@/store'

/** Compact update card for the sidebar. Hidden when there's nothing to say. */
export function UpdateBanner() {
  const u = useStore((s) => s.update)
  const call = useStore((s) => s.call)
  const installing = useBusy('install')
  if (!u || u.status === 'idle' || u.status === 'up-to-date' || u.status === 'checking') return null

  const notes = () => u.releaseUrl && void window.api.openExternal(u.releaseUrl)

  return (
    <div className="rounded-lg border border-accent/30 bg-accent/8 p-2.5 space-y-2">
      {u.status === 'available' && (
        <>
          <Row icon={<Sparkles size={13} className="text-accent" />} title={`v${u.latest} available`} sub="Downloads in the background" />
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" className="flex-1" onClick={() => void call('dl', () => window.api.downloadUpdate())}><Download size={12} /> Download</Button>
            {u.releaseUrl && <Button size="sm" variant="ghost" onClick={notes}>What's new</Button>}
          </div>
        </>
      )}
      {u.status === 'downloading' && (
        <>
          <Row icon={<Spinner className="text-accent" />} title={`Downloading v${u.latest}`} sub={`${u.percent}%`} />
          <ProgressBar value={u.percent} />
        </>
      )}
      {(u.status === 'ready' || u.status === 'installing') && (
        <>
          <Row icon={<Sparkles size={13} className="text-accent" />} title={`v${u.latest} ready`} sub={u.status === 'installing' ? 'Restarting…' : u.deferred ?? 'Restart to finish updating'} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="primary" className="flex-1" disabled={installing || u.status === 'installing'}
              onClick={() => void call('install', () => window.api.installUpdate())}>
              {installing ? <Spinner /> : <RefreshCw size={12} />} Restart now
            </Button>
            {u.releaseUrl && <Button size="sm" variant="ghost" onClick={notes}>What's new</Button>}
          </div>
        </>
      )}
      {u.status === 'error' && (
        <>
          <Row icon={<AlertTriangle size={13} className="text-warn" />} title="Update problem" sub={u.error ?? ''} />
          <div className="flex gap-1.5">
            <Button size="sm" className="flex-1" onClick={() => void call('chk', () => window.api.checkForUpdates())}><RefreshCw size={12} /> Retry</Button>
            {u.releaseUrl && <Button size="sm" variant="ghost" onClick={notes}>Download manually</Button>}
          </div>
        </>
      )}
    </div>
  )
}

function Row({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0"><div className="font-medium leading-4">{title}</div><div className="text-[11px] text-muted leading-4 break-words">{sub}</div></div>
    </div>
  )
}
