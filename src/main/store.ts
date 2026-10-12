import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import type { LastError, Playlist, PlaylistOverrides, PlaylistRule, Settings } from '@shared/types'
import type { QuotaState } from '@core/quota'
import { JsonFile, readJson } from './jsonfile'
import { secretFile, settingsFile, stateFile, tokenFile } from './paths'

export const DEFAULT_SETTINGS: Settings = {
  libraryPath: null,
  theme: 'system',
  upload: {
    dailyLimit: 6,
    privacy: 'public',
    categoryId: '22',
    tags: [],
    description: '',
    madeForKids: false,
  },
  watcher: { enabled: false, intervalMinutes: 30, startOnLogin: false, closeToTray: true },
}

export interface RecordState {
  selected?: boolean
  skipped?: boolean
  titleOverride?: string | null
  playlistOverrides?: PlaylistOverrides
  lastError?: LastError | null
}

export interface ReciterState {
  nameAr?: string | null
  prefixOverride?: string | null
  imageOverride?: string | null
}

/** User layer over the shipped surah dictionary. `null` = user deleted a default. */
export type SurahUserLayer = Record<string, string | null>

export interface LibraryStore {
  records: JsonFile<Record<string, RecordState>>
  reciters: JsonFile<Record<string, ReciterState>>
  rules: JsonFile<{ rules: PlaylistRule[] }>
  surahs: JsonFile<SurahUserLayer>
  quota: JsonFile<QuotaState>
  playlists: JsonFile<{ items: Playlist[]; fetchedAt: string | null }>
}

export async function openLibraryStore(library: string): Promise<LibraryStore> {
  const s: LibraryStore = {
    records: new JsonFile(stateFile(library, 'records.json'), () => ({})),
    reciters: new JsonFile(stateFile(library, 'reciters.json'), () => ({})),
    rules: new JsonFile(stateFile(library, 'rules.json'), () => ({ rules: [] })),
    surahs: new JsonFile(stateFile(library, 'surahs.json'), () => ({})),
    quota: new JsonFile(stateFile(library, 'quota.json'), () => ({ day: '', uploads: 0 })),
    playlists: new JsonFile(stateFile(library, 'playlists.json'), () => ({ items: [], fetchedAt: null })),
  }
  await Promise.all(Object.values(s).map((f) => f.load()))
  return s
}

export const settings = new JsonFile<Settings>(settingsFile(), () => structuredClone(DEFAULT_SETTINGS))

// ── Encrypted secrets (OS keychain-backed via safeStorage) ───────────────────

async function readSecret<T>(file: string): Promise<T | null> {
  try {
    const buf = await fs.readFile(file)
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8')
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

async function writeSecret(file: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value)
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf8')
  await fs.writeFile(file, buf)
}

export interface ClientSecret { clientId: string; clientSecret: string }
export interface StoredTokens { refresh_token?: string | null; access_token?: string | null; expiry_date?: number | null; scope?: string }

export const secrets = {
  getClient: () => readSecret<ClientSecret>(secretFile()),
  setClient: (c: ClientSecret) => writeSecret(secretFile(), c),
  getTokens: () => readSecret<StoredTokens>(tokenFile()),
  setTokens: (t: StoredTokens) => writeSecret(tokenFile(), t),
  clearTokens: () => fs.rm(tokenFile(), { force: true }),
}

export { readJson }
