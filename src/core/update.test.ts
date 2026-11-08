import { describe, expect, it } from 'vitest'
import { assetApiUrl, compareVersions, describeHttpFailure, fetchWithRetry, parseLatestYml, pickUpdateFile } from './update'

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

describe('fetchWithRetry', () => {
  const noSleep = async () => {}
  const r = (status: number) => ({ ok: status >= 200 && status < 300, status })
  it('retries transient statuses and network errors, then returns the last response', async () => {
    const calls: number[] = []
    const seq = [r(504), r(502), r(200)]
    const res = await fetchWithRetry(async () => { calls.push(1); return seq.shift()! }, 'u', undefined, [1, 1], noSleep)
    expect(res.status).toBe(200); expect(calls.length).toBe(3)
    const always = await fetchWithRetry(async () => r(504), 'u', undefined, [1, 1], noSleep)
    expect(always.status).toBe(504)
    let n = 0
    const recovered = await fetchWithRetry(async () => { if (n++ === 0) throw new Error('ECONNRESET'); return r(200) }, 'u', undefined, [1], noSleep)
    expect(recovered.status).toBe(200)
    await expect(fetchWithRetry(async () => { throw new Error('offline') }, 'u', undefined, [1], noSleep)).rejects.toThrow('offline')
  })
  it('does not retry a definite answer', async () => {
    let calls = 0
    const res = await fetchWithRetry(async () => { calls++; return r(404) }, 'u', undefined, [1, 1], noSleep)
    expect(res.status).toBe(404); expect(calls).toBe(1)
  })
  it('explains failures in plain words, naming the host that answered', () => {
    expect(describeHttpFailure('update feed', 504)).toMatch(/didn't answer \(HTTP 504\).*try again/)
    expect(describeHttpFailure('update feed', 502, 'https://release-assets.githubusercontent.com/x/y?token=1')).toContain('HTTP 502 from release-assets.githubusercontent.com')
    expect(describeHttpFailure('update feed', 502, 'not a url')).toContain('(HTTP 502)')
    expect(assetApiUrl({ assets: [{ name: 'latest.yml', url: 'https://api.github.com/repos/o/r/releases/assets/1' }] }, 'latest.yml')).toBe('https://api.github.com/repos/o/r/releases/assets/1')
    expect(assetApiUrl({ assets: [] }, 'latest.yml')).toBeNull()
    expect(assetApiUrl(null, 'latest.yml')).toBeNull()
    expect(describeHttpFailure('update feed', 404)).toMatch(/no file/)
    expect(describeHttpFailure('download server', 403)).toMatch(/refused/)
  })
})
