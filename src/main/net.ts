import { app, net, session } from 'electron'
import { DOH_SERVERS, DnsGuard, type DnsMode } from '@core/dns'
import { activity } from './log'

/**
 * The app's one way onto the internet. Requests go through Electron's network layer, where the app chooses
 * the resolver (Cloudflare, see `@core/dns`); Node's own `fetch` would use whatever DNS the computer has.
 * Nothing is remembered between requests: no cookies, no cached answers.
 */
const STATELESS = { credentials: 'omit', cache: 'no-store' } as const
/** A host the app cannot work without, used to see whether lookups succeed. */
const CHECK_HOST = 'www.googleapis.com'
const CHECK_MS = 5000

const raw = (url: string, init?: RequestInit): Promise<Response> => net.fetch(url, { ...STATELESS, ...init })

const guard = new DnsGuard({
  async apply(mode: DnsMode) {
    app.configureHostResolver({ secureDnsMode: mode === 'cloudflare' ? 'secure' : 'automatic', secureDnsServers: [...DOH_SERVERS] })
    // answers (and failures) found the other way must not outlive the switch
    await session.defaultSession.clearHostResolverCache().catch(() => {})
  },
  async reachable() {
    for (const server of DOH_SERVERS) {
      try {
        const r = await raw(`${server}?name=${CHECK_HOST}&type=A`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(CHECK_MS) })
        if (r.ok) return true
      } catch { /* try the other address */ }
    }
    return false
  },
  async resolves() {
    try { return (await net.resolveHost(CHECK_HOST, { cacheUsage: 'disallowed' })).endpoints.length > 0 } catch { return false }
  },
  online: () => net.isOnline(),
  note: (level, message) => activity[level](message),
  fetch: raw,
})

/** Choose the resolver. Call once, after the app is ready and before anything goes online. */
export function startDns(): void {
  void guard.start().catch((e) => activity.warn(`Could not set up Cloudflare DNS: ${e instanceof Error ? e.message : String(e)}`))
}

/** `fetch`, through the app's resolver. Failures before any answer come back in plain words. */
export const netFetch = (input: string | URL, init?: RequestInit): Promise<Response> =>
  guard.fetch(typeof input === 'string' ? input : input.href, init)
