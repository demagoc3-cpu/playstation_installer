import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { createError } from 'h3'
import type { SearchDetails, SearchResult } from '../../shared/types/search'
import { parseSearchSource } from './search-source-parser'

const lifetime = 30 * 60 * 1000
const maxBytes = 2 * 1024 * 1024
const releases = new Map<string, { result: SearchResult; expires: number; details?: Promise<SearchDetails> }>()

export function registerSearchResults(results: SearchResult[]) {
  for (const [id, item] of releases) if (item.expires < Date.now()) releases.delete(id)
  return results.map(result => {
    const id = createHash('sha256').update(result.source + '\n' + result.title).digest('hex')
    const previous = releases.get(id)
    const value = { ...result, id }
    releases.delete(id)
    releases.set(id, { result: value, expires: Date.now() + lifetime, details: previous?.details })
    while (releases.size > 500) releases.delete(releases.keys().next().value!)
    return value
  })
}

export function isPublicAddress(address: string) {
  if (isIP(address) === 6) return /^[23][\da-f]{3}:/i.test(address) && !/^2001:(?:0|db8):/i.test(address)
  if (isIP(address) !== 4) return false
  const [a, b] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && [0, 168].includes(b!))
    || (a === 198 && [18, 19, 51].includes(b!)) || (a === 203 && b === 0))
}

/** Pin the validated DNS answer to this connection, including every redirect. */
async function readPublicPage(url: URL, signal: AbortSignal, redirects = 0): Promise<string> {
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Invalid source')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    lookup(hostname, { all: true }), new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error('Timeout'))
      else signal.addEventListener('abort', () => reject(new Error('Timeout')), { once: true })
    })
  ])
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Nonpublic source')
  const address = addresses.find(item => item.family === 4) || addresses[0]!
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      agent: false, signal,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address] as any)
        else callback(null, address.address, address.family)
      },
      headers: { 'User-Agent': 'PackageFlow/1.0', Accept: 'text/html', 'Accept-Encoding': 'identity' }
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0) && response.headers.location) {
        response.resume()
        if (redirects >= 3) return reject(new Error('Too many redirects'))
        let next: URL
        try { next = new URL(response.headers.location, url) } catch { return reject(new Error('Invalid redirect')) }
        void readPublicPage(next, signal, redirects + 1).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(response.headers['content-type'] || '')) { response.resume(); return reject(new Error('Source unavailable')) }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { req.destroy(new Error('Page too large')); return }
        chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const charset = /charset=["']?([\w-]+)/i.exec(response.headers['content-type'] || '')?.[1] || 'utf-8'
        try { resolve(new TextDecoder(charset).decode(Buffer.concat(chunks))) } catch { reject(new Error('Invalid encoding')) }
      })
    })
    req.on('error', reject); req.end()
  })
}

export function isRuTrackerTopic(url: URL) {
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && (!url.port || ['80', '443'].includes(url.port))
    && ['rutracker.org', 'rutracker.net', 'rutracker.nl'].includes(url.hostname) && url.pathname === '/forum/viewtopic.php' && /^\d+$/.test(url.searchParams.get('t') || '')
}

async function readRuTrackerProxy(url: URL) {
  if (!isRuTrackerTopic(url)) throw new Error('Unsupported proxy source')
  // The URL is server configuration; clients cannot choose a proxy or its target.
  const endpoint = new URL(process.env.PACKAGEFLOW_FLARESOLVERR_URL || 'http://127.0.0.1:8191')
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '') + '/v1'
  const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(50000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'request.get', url: `${url.origin}/forum/viewtopic.php?t=${url.searchParams.get('t')}`, maxTimeout: 45000 }) })
  if (!response.ok) throw new Error('Proxy unavailable')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty proxy response')
  const chunks: Uint8Array[] = []; let size = 0
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > maxBytes * 3) throw new Error('Page too large'); chunks.push(next.value) }
  } finally { await reader.cancel() }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (payload.status !== 'ok' || payload.solution?.status !== 200 || typeof payload.solution.response !== 'string' || Buffer.byteLength(payload.solution.response) > maxBytes) throw new Error('Proxy source unavailable')
  if (payload.solution.url && !isRuTrackerTopic(new URL(payload.solution.url))) throw new Error('Unexpected proxy redirect')
  return payload.solution.response as string
}

async function loadDetails(result: SearchResult): Promise<SearchDetails> {
  if (!result.sourcePage) return { status: 'unavailable', fields: [], message: 'Источник не передал ссылку на страницу раздачи.' }
  try {
    const url = new URL(result.sourcePage)
    let html: string, usedProxy = false
    try { html = await readPublicPage(url, AbortSignal.timeout(10000)) }
    catch (error) { if (!isRuTrackerTopic(url)) throw error; usedProxy = true; html = await readRuTrackerProxy(url) }
    let details = parseSearchSource(html, result.sourcePage)
    if (details.status === 'unavailable' && !usedProxy && isRuTrackerTopic(url)) details = parseSearchSource(await readRuTrackerProxy(url), result.sourcePage)
    return details
  } catch { return { status: 'unavailable', fields: [], message: 'Не удалось получить описание из источника. Данные поиска сохранены; страницу раздачи можно открыть отдельно.' } }
}

export function getSearchDetails(id: string) {
  const item = releases.get(id)
  if (!item || item.expires < Date.now()) throw createError({ statusCode: 404, message: 'Результат поиска устарел. Повторите поиск.' })
  if (!item.details) item.details = loadDetails(item.result).then(value => {
    if (value.status === 'unavailable') item.details = undefined
    return value
  })
  return item.details
}
