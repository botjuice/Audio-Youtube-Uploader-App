import { create } from 'zustand'
import type { ActivityEntry, Health, Progress, Settings } from '@shared/types'
import type { LibrarySnapshot } from '@shared/api'

export type Page = 'library' | 'playlists' | 'reciters' | 'settings' | 'activity'
export interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }

interface State {
  booted: boolean
  page: Page
  settings: Settings | null
  library: LibrarySnapshot
  health: Health | null
  progress: Progress | null
  activity: ActivityEntry[]
  selectedId: string | null
  toasts: Toast[]
  busy: Record<string, boolean>
  setPage(p: Page): void
  select(id: string | null): void
  notify(kind: Toast['kind'], text: string): void
  dismiss(id: number): void
  boot(): Promise<void>
  call<T>(key: string, fn: () => Promise<T>, opts?: { success?: string }): Promise<T | undefined>
  saveSettings(patch: Partial<Settings>): Promise<void>
}

const EMPTY: LibrarySnapshot = { reciters: [], records: [], rules: [], playlists: [] }
let seq = 0

export const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

export const useStore = create<State>((set, get) => ({
  booted: false, page: 'library', settings: null, library: EMPTY, health: null, progress: null,
  activity: [], selectedId: null, toasts: [], busy: {},

  setPage: (page) => set({ page }),
  select: (selectedId) => set({ selectedId }),
  notify: (kind, text) => {
    const id = ++seq
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismiss(id), kind === 'error' ? 9000 : 3500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  boot: async () => {
    const api = window.api
    api.on('library', (library) => set({ library }))
    api.on('health', (health) => set({ health }))
    api.on('progress', (progress) => set({ progress }))
    api.on('activity', (e) => set((s) => ({ activity: [...s.activity.slice(-499), e] })))
    const [settings, library, health, activity] = await Promise.all([
      api.getSettings(), api.getLibrary(), api.getHealth(), api.getActivity(),
    ])
    set({ settings, library, health, activity, booted: true })
  },

  call: async (key, fn, opts) => {
    set((s) => ({ busy: { ...s.busy, [key]: true } }))
    try {
      const r = await fn()
      if (opts?.success) get().notify('success', opts.success)
      return r
    } catch (e) {
      get().notify('error', errText(e))
      return undefined
    } finally {
      set((s) => ({ busy: { ...s.busy, [key]: false } }))
    }
  },

  saveSettings: async (patch) => {
    try { set({ settings: await window.api.setSettings(patch) }) }
    catch (e) { get().notify('error', errText(e)) }
  },
}))

export const useBusy = (key: string) => useStore((s) => !!s.busy[key])
