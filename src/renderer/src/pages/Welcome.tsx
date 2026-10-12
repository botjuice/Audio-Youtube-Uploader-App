import { FolderOpen, Film } from 'lucide-react'
import { Button } from '@/components/ui'
import { useBusy, useStore } from '@/store'

export default function Welcome() {
  const call = useStore((s) => s.call)
  const busy = useBusy('lib')
  return (
    <div className="drag flex h-full items-center justify-center p-8">
      <div className="no-drag w-full max-w-md rounded-2xl border border-border bg-surface p-8 shadow-xl text-center space-y-5">
        <div className="mx-auto h-12 w-12 rounded-xl bg-gradient-to-br from-indigo-500 to-sky-400 flex items-center justify-center"><Film size={22} className="text-white" /></div>
        <div>
          <h1 className="text-lg font-semibold">Welcome to YouTube Quran Uploader</h1>
          <p className="text-sm text-muted mt-1">Choose the folder that holds your reciter folders. Each reciter folder should contain one photo and their audio recordings.</p>
        </div>
        <pre className="text-left text-[11px] leading-5 rounded-lg bg-surface-2 p-3 text-muted">{`Recordings/            ← choose this
├── Abdullah Al Mousa/
│   ├── photo.jpg
│   └── AbdullahAlMousaIshaMulk-01.03.2025.mp3
└── Another Reciter/
    └── …`}</pre>
        <Button variant="primary" size="lg" className="w-full" disabled={busy} onClick={() => void call('lib', () => window.api.chooseLibrary())}>
          <FolderOpen size={16} /> Choose library folder
        </Button>
        <p className="text-xs text-muted">You'll connect your Google account next, in Settings.</p>
      </div>
    </div>
  )
}
