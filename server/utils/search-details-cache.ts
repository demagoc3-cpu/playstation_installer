import { dataPath } from './data-path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, readdir, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SearchDetails } from '../../shared/types/search'
import { publicWebUrl } from './search-source-parser'

const ttl = 24 * 60 * 60 * 1000
const maxEntries = 1000, maxFileBytes = 128 * 1024
const pending = new Map<string, Promise<SearchDetails>>()
let lastPrune = 0, writesSincePrune = 0
let pruning: Promise<void> | undefined

export function detailsCacheKey(source: string) {
  const safe = publicWebUrl(source)
  if (!safe) return undefined
  const url = new URL(safe)
  url.hash = ''
  if (['rutracker.org', 'rutracker.net', 'rutracker.nl'].includes(url.hostname) && url.pathname === '/forum/viewtopic.php' && /^\d+$/.test(url.searchParams.get('t') || '')) {
    // Tracking parameters and changing download tokens do not identify the topic.
    url.search = `?t=${url.searchParams.get('t')}`
  } else url.searchParams.sort()
  return createHash('sha256').update(url.toString()).digest('hex')
}
function folder() { return dataPath('search-details-cache') }
function validDetails(value: any): value is SearchDetails {
  return value?.status === 'available' && (typeof value.description === 'string' || typeof value.cover === 'string')
    && (value.description === undefined || value.description.length <= 24000)
    && (value.cover === undefined || (value.cover.length <= 4000 && !!publicWebUrl(value.cover)))
    && Array.isArray(value.fields) && value.fields.length <= 20
    && value.fields.every((field: any) => typeof field.label === 'string' && field.label.length <= 200 && typeof field.value === 'string' && field.value.length <= 500)
}
async function prune() {
  if (pruning) return pruning
  if (Date.now() - lastPrune < 60 * 60 * 1000 && writesSincePrune < 25) return
  lastPrune = Date.now(); writesSincePrune = 0
  pruning = (async () => {
    const directory = folder()
    const files = await readdir(directory).catch(() => [] as string[])
    const entries: Array<{ path: string; time: number }> = []
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.json(?:\.[\da-f-]+\.tmp)?$/.test(name)) continue
      const path = resolve(directory, name), info = await stat(path).catch(() => undefined)
      if (!info) continue
      if (Date.now() - info.mtimeMs >= ttl || info.size > maxFileBytes || (name.endsWith('.tmp') && Date.now() - info.mtimeMs > 5 * 60 * 1000)) await unlink(path).catch(() => {})
      else if (!name.endsWith('.tmp')) entries.push({ path, time: info.mtimeMs })
    }
    entries.sort((a, b) => b.time - a.time)
    for (const entry of entries.slice(maxEntries)) await unlink(entry.path).catch(() => {})
  })().finally(() => { pruning = undefined })
  return pruning
}

/** Store only source descriptions and cover URLs, never credentials or live swarm statistics. */
export async function cachedSearchDetails(source: string, load: () => Promise<SearchDetails>, mode = 'default'): Promise<SearchDetails> {
  const key = detailsCacheKey(source)
  if (!key) return load()
  const pendingKey = `${key}:${mode}`
  const existing = pending.get(pendingKey)
  if (existing) return existing
  const task = (async () => {
    await prune()
    const path = resolve(folder(), `${key}.json`)
    try {
      const info = await stat(path)
      if (info.size > maxFileBytes) throw new Error('Invalid cache')
      const saved = JSON.parse(await readFile(path, 'utf8'))
      if (saved.version === 1 && Number.isFinite(saved.expires) && saved.expires > Date.now() && saved.expires <= Date.now() + ttl && validDetails(saved.details)) return saved.details
      await unlink(path).catch(() => {})
    } catch { /* Missing or invalid cache: refresh from HTTP. */ }
    const details = await load()
    if (validDetails(details)) {
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await mkdir(folder(), { recursive: true })
        const data = JSON.stringify({ version: 1, expires: Date.now() + ttl, details })
        if (Buffer.byteLength(data) > maxFileBytes) throw new Error('Cache too large')
        await writeFile(temporary, data, { mode: 0o600 })
        await rename(temporary, path)
        writesSincePrune++
      } catch { await unlink(temporary).catch(() => {}) }
    }
    return details
  })().finally(() => { pending.delete(pendingKey) })
  pending.set(pendingKey, task)
  return task
}
