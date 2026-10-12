import { OAuth2Client } from 'google-auth-library'
import { createServer } from 'node:http'
import { shell } from 'electron'
import { secrets, type ClientSecret } from '../store'

export const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
]

let cached: OAuth2Client | null = null

/** Parse a downloaded client_secret_*.json (installed or web type). */
export function parseClientSecretJson(text: string): ClientSecret {
  const j = JSON.parse(text) as { installed?: Record<string, string>; web?: Record<string, string> }
  const c = j.installed ?? j.web
  if (!c?.client_id || !c.client_secret) throw new Error('Not a Google OAuth client file (missing client_id / client_secret)')
  return { clientId: c.client_id, clientSecret: c.client_secret }
}

export function resetClient(): void { cached = null }

/** Authenticated client, or null if no credentials/tokens yet. Never opens a browser. */
export async function getClient(): Promise<OAuth2Client | null> {
  if (cached) return cached
  const c = await secrets.getClient()
  const tokens = await secrets.getTokens()
  if (!c || !tokens?.refresh_token) return null
  const client = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret })
  client.setCredentials(tokens)
  client.on('tokens', (t) => {
    void secrets.getTokens().then((prev) =>
      secrets.setTokens({ ...prev, ...t, refresh_token: t.refresh_token ?? prev?.refresh_token ?? null }))
  })
  cached = client
  return client
}

export async function requireClient(): Promise<OAuth2Client> {
  const c = await getClient()
  if (!c) throw new Error('Not connected to Google — open Connect and sign in')
  return c
}

export async function accessToken(): Promise<string> {
  const { token } = await (await requireClient()).getAccessToken()
  if (!token) throw new Error('Could not obtain an access token — reconnect Google')
  return token
}

function listenForCode(timeoutMs = 5 * 60_000): Promise<{ port: number; code: Promise<string> }> {
  return new Promise((resolveOuter, rejectOuter) => {
    const server = createServer()
    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out after 5 minutes')) }, timeoutMs)
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const err = url.searchParams.get('error')
        const c = url.searchParams.get('code')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        if (c) {
          res.end('<!doctype html><body style="font-family:system-ui;padding:40px;text-align:center"><h2>✓ Connected to Yoosy Joosy</h2><p>You can close this tab and return to the app.</p></body>')
          clearTimeout(timer); server.close(); resolve(c)
        } else {
          res.statusCode = 400
          res.end(`<!doctype html><body style="font-family:system-ui;padding:40px"><h2>Sign-in failed</h2><p>${err ?? 'no code returned'}</p></body>`)
          clearTimeout(timer); server.close(); reject(new Error(err ?? 'Google returned no authorization code'))
        }
      })
    })
    server.on('error', rejectOuter)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') return rejectOuter(new Error('Could not open loopback port'))
      resolveOuter({ port: addr.port, code })
    })
  })
}

/** Full browser sign-in. Stores the refresh token encrypted. */
export async function connect(): Promise<void> {
  const c = await secrets.getClient()
  if (!c) throw new Error('Add your Google OAuth client first')
  const { port, code } = await listenForCode()
  const redirectUri = `http://127.0.0.1:${port}`
  const oauth = new OAuth2Client({ clientId: c.clientId, clientSecret: c.clientSecret, redirectUri })
  const url = oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES })
  await shell.openExternal(url)
  const { tokens } = await oauth.getToken(await code)
  if (!tokens.refresh_token) throw new Error('Google did not return a refresh token — remove the app from your Google account permissions and try again')
  await secrets.setTokens(tokens)
  resetClient()
}

export async function disconnect(): Promise<void> {
  const client = await getClient()
  const tokens = await secrets.getTokens()
  if (client && tokens?.refresh_token) {
    await client.revokeToken(tokens.refresh_token).catch(() => {})
  }
  await secrets.clearTokens()
  resetClient()
}
