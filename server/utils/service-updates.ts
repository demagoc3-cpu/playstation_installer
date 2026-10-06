import { dataPath } from './data-path'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createError } from 'h3'
import { readPackageMetadata } from './package-library'
import { writeDurableJson } from './durable-json'
import { beginUpdate } from './console-maintenance'
import { ps4ServiceIp, readPs4Service } from './ps4-service'
import { consoleRuntime } from './console-control'
const directory = dataPath('service-updates')
const repository = 'demagoc3-cpu/playstation_installer'
export const updateLimit = 25 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function comparePkgVersions(a: string, b: string) { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); ++i) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d) } return 0 }
export function selectServiceReleaseAsset(assets: any[]) {
  const valid = assets.filter((a: any) => /^Pack[ea]geFlowService(?:-\d+\.\d+)?\.pkg$/.test(a.name) && Number.isSafeInteger(a.size) && a.size > 0 && a.size <= updateLimit && /^sha256:[0-9a-f]{64}$/.test(a.digest || '') && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(`https://github.com/${repository}/releases/download/`))
  // Versioned assets take precedence over a legacy unversioned PKG. This
  // lets the user keep old release attachments without hiding a newer build.
  return valid.sort((a: any, b: any) => {
    const av = a.name.match(/-(\d+\.\d+)\.pkg$/)?.[1]
    const bv = b.name.match(/-(\d+\.\d+)\.pkg$/)?.[1]
    return av && bv ? comparePkgVersions(bv, av) : av ? -1 : bv ? 1 : 0
  })[0]
}
function stagedByHash(hash: string, size: number) {
  let files: string[]
  try { files = readdirSync(directory) } catch (e: any) { if (e.code === 'ENOENT') return null; throw e }
  for (const file of files) {
    if (!file.endsWith('.json') || !uuid.test(file.slice(0, -5))) continue
    try {
      const artifact = serviceArtifact(file.slice(0, -5))
      if (artifact.sha256 === hash && artifact.size === size && createHash('sha256').update(readFileSync(artifact.path)).digest('hex') === hash) return artifact
    } catch { /* Ignore a stale or incomplete staged package. */ }
  }
  return null
}
async function bytes(url: string, limit: number) {
  for (let redirect = 0; redirect < 5; redirect++) {
    const u = new URL(url)
    if (u.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname)) throw new Error('Unexpected release URL')
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'PackageFlow', Accept: 'application/vnd.github+json' } })
    if ([301, 302, 303, 307, 308].includes(response.status)) { await response.body?.cancel(); const location = response.headers.get('location'); if (!location) throw new Error('Empty release redirect'); url = new URL(location, url).href; continue }
    if (response.status === 404) throw createError({ statusCode: 404, message: 'В GitHub ещё нет опубликованного релиза сервиса' })
    if (!response.ok || !response.body) throw new Error(`GitHub: HTTP ${response.status}`)
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > limit) throw new Error('Release exceeds limit'); chunks.push(value) } }
    finally { await reader.cancel().catch(() => {}) }
    return Buffer.concat(chunks)
  }
  throw new Error('Too many release redirects')
}
export async function latestServiceRelease(current: string) {
  try {
    const release = JSON.parse((await bytes(`https://api.github.com/repos/${repository}/releases/latest`, 128 * 1024)).toString('utf8'))
    const asset = selectServiceReleaseAsset(release.assets || [])
    if (!asset) return { available: false, message: 'В релизе нет PKG сервиса с контрольной суммой SHA-256', releaseUrl: `https://github.com/${repository}/releases` }
    const hash = asset.digest.slice(7)
    const namedVersion = asset.name.match(/-(\d+\.\d+)\.pkg$/)?.[1]
    let staged = stagedByHash(hash, asset.size)
    if (!namedVersion && !staged) {
      const data = await bytes(asset.browser_download_url, updateLimit)
      if (data.length !== asset.size) throw new Error('Размер PKG на GitHub не совпал с релизом')
      const saved = await stageServicePackage(data, hash)
      staged = serviceArtifact(saved.id)
    }
    if (namedVersion && staged && staged.version !== namedVersion) throw new Error('Версия PKG не совпала с именем файла релиза')
    const version = namedVersion || staged!.version
    const comparison = comparePkgVersions(version, current)
    const available = comparison > 0
    return { available, version, artifactId: staged?.id, asset: { url: asset.browser_download_url, sha256: hash, size: asset.size }, message: available ? `Доступен PKG ${version}` : comparison < 0 ? `Установленная версия новее опубликованной на GitHub (${version})` : 'Установлена актуальная версия', releaseUrl: release.html_url }
  } catch (e: any) { return { available: false, message: e.message || 'Не удалось проверить GitHub', releaseUrl: `https://github.com/${repository}/releases` } }
}
export async function stageServicePackage(data: Buffer, expectedHash?: string) {
  if (data.length < 4096 || data.length > updateLimit || !data.subarray(0, 4).equals(Buffer.from('7f434e54', 'hex'))) throw createError({ statusCode: 400, message: 'Ожидается PKG сервиса размером до 25 МБ' })
  const hash = createHash('sha256').update(data).digest('hex')
  if (expectedHash && hash !== expectedHash) throw createError({ statusCode: 400, message: 'Контрольная сумма обновления не совпала' })
  const id = randomUUID(); mkdirSync(directory, { recursive: true }); const path = resolve(directory, `${id}.pkg`)
  writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
  try {
    const meta = await readPackageMetadata(path, 'PackageFlowService.pkg')
    if (meta.titleId !== 'PFLS00001' || meta.contentId !== 'IV0000-PFLS00001_00-PACKAGEFLOWSRV00' || meta.contentType !== 'PS4GDE' || !/^\d{2}\.\d{2}$/.test(meta.appVersion)) throw createError({ statusCode: 400, message: 'Этот PKG не является запускателем PackageFlowService' })
    const version = meta.appVersion.replace(/^0+(?=\d)/, '')
    const artifact = { id, version, sha256: hash, size: data.length, packageDigest: meta.packageDigest }
    writeDurableJson(resolve(directory, `${id}.json`), artifact); return artifact
  } catch (e) { rmSync(path, { force: true }); throw e }
}
export function serviceArtifact(id: string) {
  if (!uuid.test(id)) throw createError({ statusCode: 400, message: 'Неверный пакет обновления' })
  try {
    const a = JSON.parse(readFileSync(resolve(directory, `${id}.json`), 'utf8')); const path = resolve(directory, `${id}.pkg`)
    if (a.id !== id || !/^\d+\.\d+$/.test(a.version) || !/^[0-9a-f]{64}$/.test(a.sha256) || !/^[0-9A-F]{64}$/.test(a.packageDigest) || a.size < 4096 || a.size > updateLimit || statSync(path).size !== a.size) throw new Error('Invalid update')
    return { ...a, path }
  } catch { throw createError({ statusCode: 404, message: 'Пакет обновления не найден' }) }
}
export async function downloadLatestServicePackage(current: string) {
  const release = await latestServiceRelease(current)
  if (!release.available || !release.asset) throw createError({ statusCode: 409, message: release.message })
  if (release.artifactId) {
    const { path: _path, ...artifact } = serviceArtifact(release.artifactId)
    return artifact
  }
  const result = await stageServicePackage(await bytes(release.asset.url, updateLimit), release.asset.sha256)
  if (result.version !== release.version) throw createError({ statusCode: 400, message: 'Версия внутри PKG не совпала с релизом' })
  return result
}
export async function installServiceArtifact(value: unknown, id: string, baseUrl: string) {
  const ip = ps4ServiceIp(value); if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  const a = serviceArtifact(id)
  if (createHash('sha256').update(readFileSync(a.path)).digest('hex') !== a.sha256) throw createError({ statusCode: 409, message: 'PKG изменился после проверки' })
  const r = await readPs4Service(ip, '/system/info'); const current = r.body as any
  if (r.status !== 200 || current?.service !== 'PackegeFlowService' || current.environment !== 'ps4' || typeof current.pkgVersion !== 'string') throw createError({ statusCode: 502, message: 'Не удалось проверить версию PS4' })
  if (comparePkgVersions(current.pkgVersion, '1.19') < 0) throw createError({ statusCode: 409, message: 'Для обновления из WEB сначала установите PKG 1.19 вручную' })
  if (comparePkgVersions(a.version, current.pkgVersion) <= 0) throw createError({ statusCode: 409, message: 'Выбранная версия уже установлена или старее текущей' })
  if ((await consoleRuntime(ip, 'PFLS00001')).running) throw createError({ statusCode: 409, message: 'Закройте запускатель PackageFlowService на PS4 перед обновлением' })
  return beginUpdate(ip, { requestId: randomUUID(), titleId: 'PFLS00001', contentId: 'IV0000-PFLS00001_00-PACKAGEFLOWSRV00', title: `PackageFlowService ${a.version}`, url: `${baseUrl}/service-update/manifest/${id}.json`, contentType: 'PS4GDE', size: a.size }, a.version)
}
