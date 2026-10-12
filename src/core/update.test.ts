import { describe, expect, it } from 'vitest'
import { compareVersions, parseLatestYml, pickUpdateFile } from './update'

const yml = `version: 2.1.0
files:
  - url: Yoosy.Joosy-2.1.0-mac-arm64.zip
    sha512: abc
    size: 100
  - url: Yoosy.Joosy-2.1.0-mac-arm64.dmg
    sha512: def
    size: 200
path: Yoosy.Joosy-2.1.0-mac-arm64.zip
sha512: abc
releaseDate: '2026-10-12T00:00:00.000Z'
`

describe('update core', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareVersions('v2.0.1', '2.0.1')).toBe(0)
    expect(compareVersions('2.0.10', '2.0.9')).toBeGreaterThan(0)
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0)
  })
  it('parses electron-builder latest yml and picks the zip on mac', () => {
    const info = parseLatestYml(yml)
    expect(info.version).toBe('2.1.0')
    expect(info.files).toHaveLength(2)
    expect(pickUpdateFile(info, 'darwin', 'arm64')?.url).toMatch(/arm64\.zip$/)
  })
  it('picks the exe on windows', () => {
    const info = parseLatestYml('version: 2.1.0\nfiles:\n  - url: Yoosy.Joosy-2.1.0-win-x64.exe\n    sha512: x\n    size: 1\n')
    expect(pickUpdateFile(info, 'win32', 'x64')?.url).toMatch(/win-x64\.exe$/)
  })
})
