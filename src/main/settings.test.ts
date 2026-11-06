import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }))
import { DEFAULT_SETTINGS, mergeSettings } from './store'

describe('mergeSettings (upgrading older settings files)', () => {
  it('a 2.4.0 file gets every newer field without losing user values', () => {
    const old = { libraryPath: '/lib', theme: 'light', upload: { dailyLimit: 100, privacy: 'private', categoryId: '22', tags: [], description: '', madeForKids: false }, watcher: { enabled: true, intervalMinutes: 5, startOnLogin: false, closeToTray: true } } as never
    const m = mergeSettings(old)
    expect(m.upload.dailyLimit).toBe(100); expect(m.upload.privacy).toBe('private')
    expect(m.upload.dailyUnits).toBe(10_000)                 // new in 2.5
    expect(m.thumbnails).toEqual({ enabled: true, sheikhPrefix: true })   // new section
    expect(m.updates).toEqual(DEFAULT_SETTINGS.updates)
    expect(m.watcher.intervalMinutes).toBe(5)
    expect(m.libraryPath).toBe('/lib')
  })
  it('empty / missing file → defaults', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS)
  })
})
