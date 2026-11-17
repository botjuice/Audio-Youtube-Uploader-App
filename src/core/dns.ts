/**
 * Every internet connection the app makes looks its hosts up through Cloudflare's resolver (1.1.1.1) over
 * HTTPS, for every user, whatever DNS the computer is set to. A network that blocks Cloudflare would leave
 * the app unable to upload or update, so when Cloudflare cannot be reached the app falls back to the
 * computer's own DNS, says so, and goes back to Cloudflare once it answers again.
 *
 * This file is the decision logic only; `src/main/net.ts` supplies the Electron side.
 */

/** Cloudflare's resolver over HTTPS, by address, so finding the resolver itself needs no lookup. */
export const DOH_SERVERS = ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query'] as const

/** `cloudflare`: 1.1.1.1 only. `fallback`: 1.1.1.1 when it answers, otherwise the computer's DNS. */
export type DnsMode = 'cloudflare' | 'fallback'

export interface DnsHost {
  /** Make every later lookup use this mode. */
  apply(mode: DnsMode): Promise<void>
  /** True when Cloudflare's resolver answers a direct request (no lookup involved). */
  reachable(): Promise<boolean>
  /** True when a fresh lookup of a host the app needs succeeds in the mode now applied. */
  resolves(): Promise<boolean>
  online(): boolean
  note(level: 'info' | 'warn', message: string): void
  fetch(url: string, init?: RequestInit): Promise<Response>
}

/** How often, while on the computer's DNS, to see whether Cloudflare answers again. */
export const RECHECK_MS = 10 * 60_000

const code = (e: unknown): string => /net::(ERR_[A-Z0-9_]+)/.exec(e instanceof Error ? e.message : String(e))?.[1] ?? ''

/** The lookup itself failed (as opposed to the host refusing, or the request being cancelled). */
export const isLookupFailure = (e: unknown): boolean => /^ERR_(NAME_NOT_RESOLVED|DNS_|NAME_RESOLUTION_FAILED)/.test(code(e))

const isAbort = (e: unknown): boolean => e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')

const hostOf = (url: string): string => { try { return new URL(url).host } catch { return url } }

/** Plain words for a connection that failed before any answer came back. The original error is kept as `cause`. */
export function explainNetError(e: unknown, url: string, online: boolean): Error {
  if (isAbort(e) || !code(e)) return e instanceof Error ? e : new Error(String(e))
  const c = code(e)
  const host = hostOf(url)
  let why: string
  if (!online || c === 'ERR_INTERNET_DISCONNECTED') why = 'this computer is offline'
  else if (isLookupFailure(e)) why = 'its address could not be found through Cloudflare DNS (1.1.1.1) or this computer\'s DNS'
  else if (/^ERR_(CERT_|SSL_)/.test(c)) why = 'something on this computer or network is intercepting the secure connection'
  else if (/^ERR_(CONNECTION_|ADDRESS_UNREACHABLE|TIMED_OUT|NETWORK_|BLOCKED_BY_|TUNNEL_|PROXY_)/.test(c)) why = 'the connection was blocked or dropped'
  else why = 'the connection failed'
  return new Error(`Can't reach ${host} — ${why} (${c}).`, { cause: e })
}

export class DnsGuard {
  mode: DnsMode = 'cloudflare'
  private switching: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private host: DnsHost, private recheckMs = RECHECK_MS) {}

  /** Call once the app can use the network. Starts on Cloudflare; falls back at once if it is not answering. */
  async start(): Promise<void> {
    await this.host.apply('cloudflare')
    if (!this.host.online()) return // nothing to judge yet; the first failed lookup decides
    if (!(await this.host.reachable()) || !(await this.host.resolves())) await this.fallBack()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null }

  /** A request through whichever resolver is in use. A failed lookup on Cloudflare is tried again on the computer's DNS. */
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const began = this.mode
    try {
      return await this.host.fetch(url, init)
    } catch (e) {
      // Only a lookup that failed on Cloudflare has somewhere else to go. (The switch may already have been
      // made by another request while this one was waiting; `fallBack` is then a no-op.)
      if (began !== 'cloudflare' || !isLookupFailure(e) || init?.signal?.aborted || !this.host.online()) throw explainNetError(e, url, this.host.online())
      await this.fallBack()
      try { return await this.host.fetch(url, init) } catch (again) { throw explainNetError(again, url, this.host.online()) }
    }
  }

  private fallBack(): Promise<void> {
    if (this.mode === 'fallback') return this.switching ?? Promise.resolve()
    this.mode = 'fallback'
    this.switching = (async () => {
      await this.host.apply('fallback')
      this.host.note('warn', 'Cloudflare DNS (1.1.1.1) can\'t be reached on this network — using this computer\'s DNS until it can.')
      this.timer ??= setInterval(() => { void this.recheck() }, this.recheckMs)
      ;(this.timer as { unref?: () => void }).unref?.()
    })().finally(() => { this.switching = null })
    return this.switching
  }

  /** While on the computer's DNS: go back to Cloudflare once it answers and lookups through it work. */
  async recheck(): Promise<void> {
    if (this.mode !== 'fallback' || this.switching || !this.host.online()) return
    if (!(await this.host.reachable())) return
    this.switching = (async () => {
      await this.host.apply('cloudflare')
      if (await this.host.resolves()) {
        this.mode = 'cloudflare'
        this.stop()
        this.host.note('info', 'Cloudflare DNS (1.1.1.1) is reachable again — using it.')
      } else {
        await this.host.apply('fallback') // it answers, yet lookups through it fail: stay where things work
      }
    })().finally(() => { this.switching = null })
    await this.switching
  }
}
