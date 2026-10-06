import { createHash, randomUUID } from 'node:crypto'

const maxBytes = 6 * 1024 * 1024
let queue: Promise<unknown> = Promise.resolve()
let session: string | undefined, currentEndpoint = ''
let idleTimer: ReturnType<typeof setTimeout> | undefined
const httpSessions = new Map<string, { expires: number; userAgent: string; cookies: Array<{ name: string; value: string; path: string; secure: boolean; expires: number }> }>()

/** Reuse verified browser cookies for HTTP, scoped to the exact source origin. */
export function browserRequestHeaders(url: URL): Record<string, string> {
  const saved = httpSessions.get(url.origin)
  if (!saved) return {}
  if (saved.expires <= Date.now()) { httpSessions.delete(url.origin); return {} }
  const cookies = saved.cookies.filter(cookie => cookie.expires > Date.now()
    && (!cookie.secure || url.protocol === 'https:')
    && (url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : cookie.path + '/')))
  return { 'User-Agent': saved.userAgent, ...(cookies.length ? { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } : {}) }
}

function rememberHttpSession(url: URL, solution: any) {
  const userAgent = solution.userAgent
  if (typeof userAgent !== 'string' || !userAgent || userAgent.length > 1000 || /[^\x20-\x7e]/.test(userAgent) || !Array.isArray(solution.cookies)) return
  const expires = Date.now() + 15 * 60 * 1000
  const cookies = solution.cookies.filter((cookie: any) => cookie && typeof cookie.name === 'string'
    && /^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(cookie.name) && typeof cookie.value === 'string'
    && !/[\x00-\x20\x7f;,]/.test(cookie.value) && cookie.value.length <= 4000
    && typeof cookie.domain === 'string' && cookie.domain.replace(/^\./, '').toLowerCase() === url.hostname
    && typeof cookie.path === 'string' && cookie.path.startsWith('/'))
    .map((cookie: any) => ({ name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure === true,
      expires: typeof cookie.expiry === 'number' && cookie.expiry > 0 ? Math.min(expires, cookie.expiry * 1000) : expires }))
  httpSessions.set(url.origin, { expires, userAgent, cookies })
}

class LostBrowserSession extends Error {}
function lostSession(message: unknown) {
  return /invalid session id|session.*(?:not|missing|invalid|exist)|(?:invalid|no such).*session|no such window|target window already closed|chrome not reachable|disconnected.*(?:devtools|browser)/i.test(String(message))
}

async function command(endpoint: string, body: Record<string, unknown>, timeout: number) {
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty proxy response')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > maxBytes) throw new Error('Proxy response too large')
      chunks.push(next.value)
    }
  } finally { await reader.cancel() }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  // FlareSolverr reports Selenium session failures with HTTP 500 as well as JSON status=error.
  if (value.status !== 'ok' && lostSession(value.message)) throw new LostBrowserSession('Browser session expired')
  if (!response.ok) throw new Error('Proxy unavailable')
  return value
}
async function destroy() {
  const previous = session, endpoint = currentEndpoint
  session = undefined
  if (previous) await command(endpoint, { cmd: 'sessions.destroy', session: previous }, 15000).catch(() => {})
}
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const task = queue.then(work, work)
  queue = task.catch(() => {})
  return task
}

/** One reusable browser, serialized requests, and automatic cleanup after five idle minutes. */
export function readBrowserPage(endpoint: string, url: string): Promise<{ html: string; url?: string }> {
  if (idleTimer) clearTimeout(idleTimer)
  return serialized(async () => {
    if (idleTimer) clearTimeout(idleTimer)
    if (currentEndpoint !== endpoint) { await destroy(); httpSessions.clear(); currentEndpoint = endpoint }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!session) {
          const base = `packageflow-search-${createHash('sha256').update(process.cwd() + endpoint).digest('hex').slice(0, 16)}`
          // A failed destroy may leave a dead entry in FlareSolverr's session list.
          const name = attempt ? `${base}-${randomUUID()}` : base
          const existing = await command(endpoint, { cmd: 'sessions.list' }, 15000)
          if (existing.status === 'ok' && Array.isArray(existing.sessions) && existing.sessions.includes(name)) session = name
          else {
            const created = await command(endpoint, { cmd: 'sessions.create', session: name }, 15000)
            if (created.status !== 'ok' || typeof created.session !== 'string' || !created.session) throw new Error('Proxy session unavailable')
            session = created.session
          }
        }
        let value
        try { value = await command(endpoint, { cmd: 'request.get', session, url, maxTimeout: 45000 }, 50000) }
        catch (error) {
          if (attempt === 0 && error instanceof LostBrowserSession) { await destroy(); continue }
          throw error
        }
        if (value.status === 'ok' && value.solution?.status === 200 && typeof value.solution.response === 'string' && Buffer.byteLength(value.solution.response) <= 2 * 1024 * 1024) {
          // Caller validates the final redirect URL against the allowed source.
          if (value.solution.url && new URL(value.solution.url).origin !== new URL(url).origin) throw new Error('Unexpected proxy redirect')
          if (/_cf_chl_opt|cf-turnstile-response|<title[^>]*>\s*(?:just a moment|один момент|un momento)/i.test(value.solution.response)) throw new Error('Browser verification incomplete')
          rememberHttpSession(new URL(url), value.solution)
          return { html: value.solution.response, url: value.solution.url }
        }
        if (attempt === 0 && lostSession(value.message)) { await destroy(); continue }
        throw new Error('Proxy source unavailable')
      }
      throw new Error('Proxy session unavailable')
    } finally {
      idleTimer = setTimeout(() => { void serialized(destroy) }, 5 * 60 * 1000)
      idleTimer.unref()
    }
  })
}

export async function closeSearchBrowser(preserveHttpSession = false) {
  if (idleTimer) clearTimeout(idleTimer)
  await serialized(destroy)
  if (!preserveHttpSession) httpSessions.clear()
}
