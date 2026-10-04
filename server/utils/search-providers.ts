import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { writeJsonFile } from './json-store'
import type { SearchResult } from '../../shared/types/search'
import { searchTitleMetadata } from '../../shared/search-metadata'
import { htmlText, publicWebUrl } from './search-source-parser'
import { registerSearchResults } from './search-source'

const settingsPath = resolve(process.cwd(), '.data/search-providers.json')
export interface SearchSettings { name: string; endpoint: string; apiKey: string; categories: string }
export interface PublicSearchSettings { name: string; endpoint: string; categories: string; hasApiKey: boolean; configured: boolean }

const blank = (): SearchSettings => ({ name: 'Torznab', endpoint: '', apiKey: '', categories: '1180' })
function readSettings(): SearchSettings {
  try {
    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'))
    let category = '1180'
    try { category = new URL(stored.endpoint).searchParams.get('cat') ?? category } catch { /* Validated before searching. */ }
    return { ...blank(), ...stored, categories: stored.categories ?? category }
  } catch { return blank() }
}
function publicSettings(settings: SearchSettings): PublicSearchSettings {
  let endpoint = settings.endpoint, keyInUrl = false
  try { const url = new URL(endpoint); keyInUrl = !!url.searchParams.get('apikey'); url.searchParams.delete('apikey'); endpoint = url.toString() } catch { /* Empty source. */ }
  return { name: settings.name, endpoint, categories: settings.categories, hasApiKey: !!settings.apiKey || keyInUrl, configured: existsSync(settingsPath) && !!settings.endpoint }
}
function writeSettings(settings: SearchSettings) { writeJsonFile(settingsPath, settings) }

function validate(input: Partial<SearchSettings>) {
  const previous = readSettings(), settings = { ...previous, ...input }
  if (typeof settings.endpoint !== 'string' || typeof settings.name !== 'string' || typeof settings.apiKey !== 'string' || typeof settings.categories !== 'string') throw createError({ statusCode: 400, message: 'Неверные настройки источника поиска' })
  let url: URL
  try { url = new URL(settings.endpoint) } catch { throw createError({ statusCode: 400, message: 'Укажите URL Torznab-источника' }) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw createError({ statusCode: 400, message: 'URL источника должен быть обычным HTTP(S)-адресом без логина и пароля' })
  const categories = (input.categories ?? (input.endpoint ? url.searchParams.get('cat') : null) ?? settings.categories).trim()
  if (categories && !/^\d{1,6}(,\d{1,6})*$/.test(categories)) throw createError({ statusCode: 400, message: 'Категории Torznab: укажите номера через запятую' })
  const apiKey = input.apiKey?.trim() || url.searchParams.get('apikey') || previous.apiKey
  url.searchParams.delete('apikey')
  return { ...settings, name: settings.name.trim() || 'Torznab', endpoint: url.toString(), apiKey, categories }
}

function entities(value: string) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, name: string) => {
    if (name[0] === '#') { const n = Number.parseInt(name.slice(name[1]?.toLowerCase() === 'x' ? 2 : 1), name[1]?.toLowerCase() === 'x' ? 16 : 10); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : match }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' } as Record<string, string>)[name.toLowerCase()] || match
  })
}
function text(value: string) { return value.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/g).map(part => part.startsWith('<![CDATA[') ? part.slice(9, -3) : entities(part)).join('').trim() }
function tag(block: string, name: string) { const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}\\s*>`, 'i').exec(block); return match ? text(match[1] ?? '') : '' }
function attr(element: string, key: string) { return entities(new RegExp(`\\b${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(element)?.slice(1).find(value => value !== undefined) || '') }
function torznabAttr(block: string, name: string) {
  for (const match of block.matchAll(/<(?:[\w.-]+:)?attr\b[^>]*>/gi)) if (attr(match[0], 'name') === name) return attr(match[0], 'value')
  return ''
}
function positiveNumber(value: string) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : 0 }
function optionalNumber(value: string) { return value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined }

export function parseTorznabResults(xml: string): SearchResult[] {
  const error = /<error\b[^>]*>/i.exec(xml)?.[0]
  if (error) throw createError({ statusCode: 502, message: 'Источник Torznab вернул ошибку. Проверьте API‑ключ и настройки индексатора.' })
  if (!/<rss\b/i.test(xml)) throw createError({ statusCode: 502, message: 'Источник вернул неверный ответ Torznab' })
  const results: SearchResult[] = [], seen = new Set<string>()
  for (const match of xml.matchAll(/<item\b[\s\S]*?<\/item\s*>/gi)) {
    const block = match[0], enclosure = /<enclosure\b[^>]*>/i.exec(block)?.[0] || ''
    const source = torznabAttr(block, 'magneturl') || attr(enclosure, 'url') || tag(block, 'link') || tag(block, 'guid')
    if (!/^(magnet:\?|https?:\/\/)/i.test(source) || seen.has(source)) continue
    seen.add(source)
    const title = tag(block, 'title') || 'Без названия'
    const categories = [...new Set([
      ...[...block.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category\s*>/gi)].map(m => text(m[1]!)),
      ...[...block.matchAll(/<(?:[\w.-]+:)?attr\b[^>]*>/gi)].filter(m => attr(m[0], 'name') === 'category').map(m => attr(m[0], 'value'))
    ])].filter(value => /^\d+$/.test(value))
    const description = htmlText(tag(block, 'description'), 4000)
    const indexer = tag(block, 'prowlarrindexer') || tag(block, 'jackettindexer') || undefined
    const sourcePage = publicWebUrl(tag(block, 'comments')) || publicWebUrl(tag(block, 'guid'))
    const media = /<(?:media:thumbnail|media:content)\b[^>]*>/i.exec(block)?.[0] || ''
    const cover = publicWebUrl(torznabAttr(block, 'coverurl') || tag(block, 'coverurl') || attr(media, 'url'))
    const seeders = optionalNumber(torznabAttr(block, 'seeders')), peers = optionalNumber(torznabAttr(block, 'peers'))
    const leechers = optionalNumber(torznabAttr(block, 'leechers')) ?? (peers !== undefined && seeders !== undefined ? Math.max(0, peers - seeders) : undefined)
    results.push({ title, source, size: positiveNumber(attr(enclosure, 'length') || torznabAttr(block, 'size') || tag(block, 'size')),
      seeders, leechers, peers, grabs: optionalNumber(torznabAttr(block, 'grabs')), published: tag(block, 'pubDate') || undefined,
      sourcePage, indexer, cover, description: description && description !== title ? description : undefined,
      categories, ...searchTitleMetadata(title, categories) })
    if (results.length === 40) break
  }
  return results
}

export function getSearchSettings() { return publicSettings(readSettings()) }
export function saveSearchSettings(input: Partial<SearchSettings>) { const settings = validate(input); writeSettings(settings); return publicSettings(settings) }

export async function searchPackages(query: string) {
  const settings = readSettings()
  if (!existsSync(settingsPath)) throw createError({ statusCode: 409, message: 'Сначала настройте разрешённый Torznab-источник' })
  const verified = validate(settings)
  const request = new URL(verified.endpoint)
  request.searchParams.set('t', 'search'); request.searchParams.set('q', query.trim())
  request.searchParams.set('extended', '1')
  if (verified.categories) request.searchParams.set('cat', verified.categories)
  else request.searchParams.delete('cat')
  if (verified.apiKey) request.searchParams.set('apikey', verified.apiKey)
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60000)
  let response: Response, xml: string
  try { response = await fetch(request, { signal: controller.signal }); xml = await response.text() } catch { throw createError({ statusCode: 502, message: 'Источник поиска не ответил' }) } finally { clearTimeout(timer) }
  if (!response.ok) throw createError({ statusCode: 502, message: `Источник поиска вернул ошибку ${response.status}` })
  return registerSearchResults(parseTorznabResults(xml).map(result => ({ ...result, indexer: result.indexer || verified.name })))
}
