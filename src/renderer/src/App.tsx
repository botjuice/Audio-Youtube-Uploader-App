import { clsx } from 'clsx'
import { useEffect } from 'react'
import { Sidebar } from '@/components/Sidebar'
import { Spinner } from '@/components/ui'
import { useStore } from '@/store'
import Activity from '@/pages/Activity'
import Library from '@/pages/Library'
import Playlists from '@/pages/Playlists'
import Reciters from '@/pages/Reciters'
import Settings from '@/pages/Settings'
import Welcome from '@/pages/Welcome'

export default function App() {
  const booted = useStore((s) => s.booted)
  const boot = useStore((s) => s.boot)
  const page = useStore((s) => s.page)
  const settings = useStore((s) => s.settings)
  useEffect(() => { void boot() }, [boot])

  if (!booted || !settings) return <div className="drag flex h-full items-center justify-center text-muted"><Spinner /></div>
  if (!settings.libraryPath) return <Welcome />

  const Page = { library: Library, playlists: Playlists, reciters: Reciters, settings: Settings, activity: Activity }[page]
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="flex-1 min-w-0 min-h-0"><Page /></main>
      <Toasts />
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
      {toasts.map((t) => (
        <button key={t.id} onClick={() => dismiss(t.id)}
          className={clsx('pointer-events-auto rounded-lg border px-3 py-2 text-left text-xs shadow-lg backdrop-blur',
            t.kind === 'error' ? 'border-err/40 bg-err/10 text-err' : t.kind === 'success' ? 'border-ok/40 bg-ok/10 text-ok' : 'border-border bg-surface text-text')}>
          {t.text}
        </button>
      ))}
    </div>
  )
}
