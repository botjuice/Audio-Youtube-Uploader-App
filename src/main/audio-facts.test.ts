import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { FACTS_STORE_VERSION, moveFacts, pruneFacts, untilAborted } from './audio-facts'
import { writeJson } from './jsonfile'
import { stateFile } from './paths'

const library = mkdtempSync(join(tmpdir(), 'yj-facts-'))
afterAll(() => rmSync(library, { recursive: true, force: true }))
const stored = () => Object.keys((JSON.parse(readFileSync(stateFile(library, 'audio-facts.json'), 'utf8')) as { files: Record<string, unknown> }).files).sort()

describe('waiting for shared work', () => {
  it('ends the caller’s wait on cancel while the work itself carries on', async () => {
    let finish: (v: string) => void = () => {}
    const work = new Promise<string>((res) => { finish = res })
    const ac = new AbortController()
    const waiting = untilAborted(work, ac.signal)
    ac.abort()
    await expect(waiting).rejects.toThrow('Cancelled')
    finish('measured')
    await expect(untilAborted(work, new AbortController().signal)).resolves.toBe('measured')   // the result is there for the next caller
    await expect(untilAborted(work, ac.signal)).rejects.toThrow('Cancelled')                    // already cancelled: not even started
    await expect(untilAborted(work)).resolves.toBe('measured')
  })
})

describe('stored facts follow the library', () => {
  it('move with a renamed recording and go when the recording is gone', async () => {
    const entry = { size: 1, mtimeMs: 2, measure: {}, analysis: {}, ring: null }
    await writeJson(stateFile(library, 'audio-facts.json'), { v: FACTS_STORE_VERSION, files: { 'R/a.m4a': entry, 'R/b.m4a': entry, 'R/c.m4a': entry } })
    await moveFacts(library, 'R/a.m4a', 'R/a2.m4a')
    await moveFacts(library, 'R/none.m4a', 'R/x.m4a')
    expect(stored()).toEqual(['R/a2.m4a', 'R/b.m4a', 'R/c.m4a'])
    await pruneFacts(library, new Set(['R/a2.m4a', 'R/c.m4a']))
    expect(stored()).toEqual(['R/a2.m4a', 'R/c.m4a'])
  })
})
