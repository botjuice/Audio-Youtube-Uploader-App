import { clsx } from 'clsx'
import { Activity as ActivityIcon } from 'lucide-react'
import { useState } from 'react'
import { Empty, Select } from '@/components/ui'
import { fmtTime } from '@/lib/format'
import { useStore } from '@/store'

export default function Activity() {
  const entries = useStore((s) => s.activity)
  const select = useStore((s) => s.select)
  const setPage = useStore((s) => s.setPage)
  const [level, setLevel] = useState<'all' | 'error'>('all')
  const shown = [...entries].reverse().filter((e) => level === 'all' || e.level === 'error' || e.level === 'warn')
  const color = { info: 'text-muted', warn: 'text-warn', error: 'text-err', success: 'text-ok' }
  return (
    <div className="flex h-full flex-col">
      <div className="drag h-13 flex items-center gap-3 px-6 border-b border-border">
        <h1 className="font-semibold">Activity</h1>
        <Select value={level} onChange={(e) => setLevel(e.target.value as 'all' | 'error')} className="ml-auto h-8"><option value="all">Everything</option><option value="error">Problems only</option></Select>
      </div>
      <div className="flex-1 overflow-auto font-mono text-[12px]">
        {shown.length === 0 ? <Empty icon={<ActivityIcon size={28} />} title="Nothing yet" hint="Uploads, renames, watcher runs and errors show up here." /> : (
          <ul className="p-3 space-y-0.5">
            {shown.map((e, i) => (
              <li key={i} className="flex gap-3 rounded px-2 py-1 hover:bg-surface-2/70">
                <span className="text-muted/70 shrink-0 tabular-nums">{fmtTime(e.at)}</span>
                <span className={clsx('min-w-0 break-words', color[e.level])}>
                  {e.message}
                  {e.recordId && <button className="ml-2 text-accent hover:underline" onClick={() => { select(e.recordId!); setPage('library') }}>open</button>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
