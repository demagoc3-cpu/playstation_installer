import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeJsonFile } from './json-store'

const settingsPath = resolve(process.cwd(), '.data/search-providers.json')
export interface SearchSettings { name: string; endpoint: string; apiKey: string }
export interface PublicSearchSettings { name: string; endpoint: string; configured: boolean }
export interface SearchResult { title: string; source: string; size: number; seeders?: number; published?: string }

const blank = (): SearchSettings => ({ name: 'Torznab', endpoint: '', apiKey: '' })
function readSettings() { try { return { ...blank(), ...JSON.parse(readFileSync(settingsPath, 'utf8')) } } catch { return blank() } }
function publicSettings(settings: SearchSettings): PublicSearchSettings { return { name: settings.name, endpoint: settings.endpoint, configured: existsSync(settingsPath) } }
function writeSettings(settings: SearchSettings) { writeJsonFile(settingsPath, settings) }

function validate(input: Partial<SearchSettings>) {
  const settings = { ...readSettings(), ...input }
  let url: URL
  try { url = new URL(settings.endpoint) } catch { throw createError({ statusCode: 400, message: 'Укажите URL Torznab-источника' }) }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw createError({ statusCode: 400, message: 'URL источника должен быть обычным HTTP(S)-адресом без логина и пароля' })
  return { ...settings, name: settings.name.trim() || 'Torznab', endpoint: url.toString(), apiKey: settings.apiKey.trim() }
}

function text(value: string) { return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() }
function tag(block: string, name: string) { const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block); return match ? text(match[1] ?? '') : '' }
function attr(block: string, name: string, key: string) { const element = new RegExp(`<${name}[^>]*>`, 'i').exec(block)?.[0] || ''; return new RegExp(`${key}=["']([^"']+)["']`, 'i').exec(element)?.[1] || '' }
function torznabAttr(block: string, name: string) { const match = new RegExp(`<torznab:attr[^>]*name=["']${name}["'][^>]*value=["']([^"']+)["']`, 'i').exec(block); return match?.[1] || '' }

export function getSearchSettings() { return publicSettings(readSettings()) }
export function saveSearchSettings(input: Partial<SearchSettings>) { const settings = validate(input); writeSettings(settings); return publicSettings(settings) }

export async function searchPackages(query: string) {
  const settings = readSettings()
  if (!existsSync(settingsPath)) throw createError({ statusCode: 409, message: 'Сначала настройте разрешённый Torznab-источник' })
  const verified = validate(settings)
  const request = new URL(verified.endpoint)
  request.searchParams.set('t', 'search'); request.searchParams.set('q', query.trim())
  if (verified.apiKey) request.searchParams.set('apikey', verified.apiKey)
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 12000)
  let response: Response
  try { response = await fetch(request, { signal: controller.signal }) } catch { throw createError({ statusCode: 502, message: 'Источник поиска не ответил' }) } finally { clearTimeout(timer) }
  if (!response.ok) throw createError({ statusCode: 502, message: `Источник поиска вернул ошибку ${response.status}` })
  const xml = await response.text()
  return [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 40).map((match) => {
    const block = match[0]
    const source = attr(block, 'enclosure', 'url') || tag(block, 'link') || tag(block, 'guid')
    return { title: tag(block, 'title') || 'Без названия', source, size: Number(attr(block, 'enclosure', 'length') || torznabAttr(block, 'size') || 0), seeders: Number(torznabAttr(block, 'seeders') || 0) || undefined, published: tag(block, 'pubDate') || undefined }
  }).filter((item) => /^(magnet:|https?:\/\/)/i.test(item.source))
}
