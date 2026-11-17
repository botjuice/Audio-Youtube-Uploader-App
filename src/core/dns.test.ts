import { describe, expect, it } from 'vitest'
import { DnsGuard, explainNetError, isLookupFailure, type DnsHost, type DnsMode } from './dns'

const lookupError = () => new Error('net::ERR_NAME_NOT_RESOLVED')
const ok = () => new Response('ok')

/** A network where Cloudflare can be switched off, and where the computer's own DNS can be broken too. */
function network(o: { cloudflare?: boolean; system?: boolean; online?: boolean; lookupsThroughCloudflare?: boolean } = {}) {
  const net = { cloudflare: true, system: true, online: true, lookupsThroughCloudflare: true, ...o }
  const applied: DnsMode[] = []
  const notes: string[] = []
  const fetched: DnsMode[] = []
  let mode: DnsMode = 'cloudflare'
  const works = () => (net.cloudflare && net.lookupsThroughCloudflare) || (mode === 'fallback' && net.system)
  const host: DnsHost = {
    async apply(m) { mode = m; applied.push(m) },
    async reachable() { return net.cloudflare },
    async resolves() { return works() },
    online: () => net.online,
    note: (level, message) => { notes.push(`${level}: ${message}`) },
    async fetch() { fetched.push(mode); if (!works()) throw lookupError(); return ok() },
  }
  return { net, host, applied, notes, fetched }
}

describe('DnsGuard', () => {
  it('uses Cloudflare only, and says nothing, where Cloudflare answers', async () => {
    const n = network()
    const g = new DnsGuard(n.host)
    await g.start()
    expect((await g.fetch('https://www.googleapis.com/x')).ok).toBe(true)
    expect(n.applied).toEqual(['cloudflare'])
    expect(n.notes).toEqual([])
    g.stop()
  })

  it('falls back at start where Cloudflare is blocked, before any request has to fail', async () => {
    const n = network({ cloudflare: false })
    const g = new DnsGuard(n.host)
    await g.start()
    expect(g.mode).toBe('fallback')
    expect((await g.fetch('https://www.googleapis.com/x')).ok).toBe(true)
    expect(n.fetched).toEqual(['fallback'])
    expect(n.notes).toHaveLength(1)
    expect(n.notes[0]).toMatch(/^warn: Cloudflare DNS \(1\.1\.1\.1\) can't be reached/)
    g.stop()
  })

  it('falls back at start where Cloudflare answers but lookups through it fail', async () => {
    const n = network({ lookupsThroughCloudflare: false })
    const g = new DnsGuard(n.host)
    await g.start()
    expect(g.mode).toBe('fallback')
    g.stop()
  })

  it('retries a failed lookup on the computer\'s DNS when Cloudflare goes away mid-session, once', async () => {
    const n = network()
    const g = new DnsGuard(n.host)
    await g.start()
    n.net.cloudflare = false
    const all = await Promise.all([g.fetch('https://a.example/1'), g.fetch('https://a.example/2'), g.fetch('https://a.example/3')])
    expect(all.every((r) => r.ok)).toBe(true)
    expect(n.applied).toEqual(['cloudflare', 'fallback'])
    expect(n.notes).toHaveLength(1)
    g.stop()
  })

  it('goes back to Cloudflare when it answers again', async () => {
    const n = network({ cloudflare: false })
    const g = new DnsGuard(n.host)
    await g.start()
    await g.recheck()
    expect(g.mode).toBe('fallback')
    n.net.cloudflare = true
    await g.recheck()
    expect(g.mode).toBe('cloudflare')
    expect(n.applied).toEqual(['cloudflare', 'fallback', 'cloudflare'])
    expect(n.notes[1]).toMatch(/^info: Cloudflare DNS \(1\.1\.1\.1\) is reachable again/)
    await g.fetch('https://a.example/')
    expect(n.fetched.at(-1)).toBe('cloudflare')
  })

  it('stays on the computer\'s DNS when Cloudflare answers but lookups through it still fail', async () => {
    const n = network({ lookupsThroughCloudflare: false })
    const g = new DnsGuard(n.host)
    await g.start()
    await g.recheck()
    expect(g.mode).toBe('fallback')
    expect(n.applied.at(-1)).toBe('fallback')
    expect(n.notes).toHaveLength(1)
    expect((await g.fetch('https://a.example/')).ok).toBe(true)
    g.stop()
  })

  it('does not blame Cloudflare while the computer is offline', async () => {
    const n = network({ online: false, cloudflare: false, system: false })
    const g = new DnsGuard(n.host)
    await g.start()
    await expect(g.fetch('https://www.googleapis.com/x')).rejects.toThrow('Can\'t reach www.googleapis.com — this computer is offline')
    expect(g.mode).toBe('cloudflare')
    expect(n.notes).toEqual([])
  })

  it('reports plainly when neither resolver finds the host', async () => {
    const n = network({ cloudflare: false, system: false })
    const g = new DnsGuard(n.host)
    await g.start()
    await expect(g.fetch('https://oauth2.googleapis.com/token')).rejects.toThrow(
      'Can\'t reach oauth2.googleapis.com — its address could not be found through Cloudflare DNS (1.1.1.1) or this computer\'s DNS (ERR_NAME_NOT_RESOLVED).')
    expect(n.fetched).toEqual(['fallback'])
    g.stop()
  })

  it('leaves a cancelled request alone', async () => {
    const n = network()
    const abort = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    n.host.fetch = async () => { throw abort }
    const g = new DnsGuard(n.host)
    await g.start()
    await expect(g.fetch('https://a.example/')).rejects.toBe(abort)
    expect(g.mode).toBe('cloudflare')
  })

  it('does not fall back for failures that are not lookups', async () => {
    const n = network()
    n.host.fetch = async () => { throw new Error('net::ERR_CONNECTION_RESET') }
    const g = new DnsGuard(n.host)
    await g.start()
    await expect(g.fetch('https://www.googleapis.com/upload')).rejects.toThrow('Can\'t reach www.googleapis.com — the connection was blocked or dropped (ERR_CONNECTION_RESET).')
    expect(g.mode).toBe('cloudflare')
  })
})

describe('explainNetError', () => {
  it('recognises lookup failures', () => {
    expect(isLookupFailure(new Error('net::ERR_NAME_NOT_RESOLVED'))).toBe(true)
    expect(isLookupFailure(new Error('net::ERR_DNS_TIMED_OUT'))).toBe(true)
    expect(isLookupFailure(new Error('net::ERR_CONNECTION_REFUSED'))).toBe(false)
    expect(isLookupFailure(new Error('quotaExceeded'))).toBe(false)
  })
  it('keeps the original error as the cause and passes other errors through', () => {
    const e = new Error('net::ERR_CERT_AUTHORITY_INVALID')
    const x = explainNetError(e, 'https://www.googleapis.com/y', true)
    expect(x.message).toBe('Can\'t reach www.googleapis.com — something on this computer or network is intercepting the secure connection (ERR_CERT_AUTHORITY_INVALID).')
    expect(x.cause).toBe(e)
    const other = new Error('YouTube API daily quota is used up.')
    expect(explainNetError(other, 'https://www.googleapis.com/y', true)).toBe(other)
  })
})
