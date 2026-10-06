import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { dataPath } from './data-path'
import { readJsonFile, writeJsonFile } from './json-store'
import { assertDesktopWritable } from './desktop-lifecycle'
import { getLibraryPackages, type LocalPackage } from './package-library'
import { librarySearchTokens, matchesLibrarySearch } from '../../shared/library-pagination'
import type { Preset, PresetPackage, PresetItem } from '../../shared/types/presets'
const file = dataPath('presets.json')
const read = () => readJsonFile<{ version: 1; presets: Preset[] }>(file, { version: 1, presets: [] })
export const presetPackageKey = (item: PresetPackage) => JSON.stringify([item.titleId, item.contentId, item.digest || '', item.fileName])
function name(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\x00-\x1f]/.test(value)) throw createError({ statusCode: 400, message: 'Введите название пресета (до 120 символов)' })
  return value.trim()
}
function description(value: unknown) { if (value === undefined) return ""; if (typeof value !== "string" || value.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw createError({ statusCode: 400, message: "Описание пресета: до 2000 символов" }); return value.trim() }
export function getPreset(id: unknown) {
  const preset = read().presets.find(item => item.id === id)
  if (!preset) throw createError({ statusCode: 404, message: 'Пресет не найден' })
  return preset
}
function indexLibrary(library: LocalPackage[]) {
  return {
    id: new Map(library.flatMap(item => [item.id, ...(item.sourceIds || [])].map(id => [id, item] as const))),
    digest: new Map(library.filter(item => item.packageDigest).map(item => [JSON.stringify([item.titleId, item.contentId, item.packageDigest.toUpperCase(), item.size]), item])),
    file: new Map(library.map(item => [JSON.stringify([item.titleId, item.contentId, item.fileName, item.size]), item])),
    branches: new Map(library.filter(item => item.type === 'Игра').map(item => [item.titleId, item])),
  }
}
export function resolvePreset(preset: Preset, library = getLibraryPackages()) {
  const index = indexLibrary(library)
  return preset.packages.map(ref => {
    const pkg = ref.digest ? index.digest.get(JSON.stringify([ref.titleId, ref.contentId, ref.digest.toUpperCase(), ref.size])) : index.file.get(JSON.stringify([ref.titleId, ref.contentId, ref.fileName, ref.size]))
    const base = index.branches.get(ref.titleId)
    const item: PresetItem = { ...ref, appVersion: pkg?.appVersion, masterVersion: pkg?.masterVersion, requiredFirmware: pkg?.requiredFirmware, sdkFirmware: pkg?.sdkFirmware, contentType: pkg?.contentType, packageDigest: pkg?.packageDigest, key: presetPackageKey(ref), title: pkg?.title || ref.title, groupTitle: base?.title || ref.groupTitle, size: pkg?.size ?? ref.size, packageId: pkg?.id, available: !!pkg, iconId: base?.iconSize ? base.id : pkg?.iconSize ? pkg.id : undefined, installed: !!pkg?.installedAt }
    return { item, pkg }
  })
}
export function presetSummary(preset: Preset, library = getLibraryPackages()) {
  const resolved = resolvePreset(preset, library)
  return { id: preset.id, name: preset.name, description: preset.description || "", covers: [...new Map(resolved.map(entry => [entry.item.titleId, { title: entry.item.groupTitle, iconId: entry.item.iconId }])).values()].slice(0, 5), games: new Set(preset.packages.map(item => item.titleId || item.contentId)).size, files: resolved.length, size: resolved.reduce((sum, entry) => sum + entry.item.size, 0), available: resolved.filter(entry => entry.pkg).length, missing: resolved.filter(entry => !entry.pkg).length, updatedAt: preset.updatedAt }
}
export function listPresets(query: { page?: unknown; pageSize?: unknown; q?: unknown } = {}) {
  const library = getLibraryPackages(), tokens = librarySearchTokens(query.q)
  const filtered = read().presets.filter(item => tokens.every(token => `${item.name} ${item.description || ""}`.toLocaleLowerCase().includes(token))).sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }) || a.id.localeCompare(b.id))
  const size = [10, 20, 25, 30, 50, 100].includes(Number(query.pageSize)) ? Number(query.pageSize) : 25
  const pages = Math.max(1, Math.ceil(filtered.length / size)), page = Math.min(pages, Math.max(1, Math.floor(Number(query.page) || 1)))
  return { items: filtered.slice((page - 1) * size, page * size).map(item => presetSummary(item, library)), page, pages, total: filtered.length }
}
export function presetPage(id: unknown, query: { page?: unknown; pageSize?: unknown; q?: unknown } = {}) {
  const preset = getPreset(id), library = getLibraryPackages(), resolved = resolvePreset(preset, library), tokens = librarySearchTokens(query.q)
  const matching = new Set(resolved.filter(entry => matchesLibrarySearch({ ...entry.item, installOrder: 0, title: `${entry.item.groupTitle} ${entry.item.title}` }, tokens)).map(entry => entry.item.titleId))
  const groups = [...new Set(resolved.filter(entry => matching.has(entry.item.titleId)).map(entry => entry.item.titleId))]
  const size = [10, 20, 25, 30, 50, 100].includes(Number(query.pageSize)) ? Number(query.pageSize) : 25
  const pages = Math.max(1, Math.ceil(groups.length / size)), page = Math.min(pages, Math.max(1, Math.floor(Number(query.page) || 1))), ids = new Set(groups.slice((page - 1) * size, page * size))
  return { ...presetSummary(preset, library), items: resolved.filter(entry => ids.has(entry.item.titleId)).map(entry => entry.item), page, pages, total: groups.length }
}
export function mutatePreset(body: any) {
  assertDesktopWritable()
  const store = read()
  if (body?.action === 'create') {
    const now = Date.now(), preset: Preset = { id: randomUUID(), name: name(body.name), description: description(body.description), packages: [], createdAt: now, updatedAt: now }
    store.presets.push(preset); writeJsonFile(file, store); return presetSummary(preset)
  }
  const preset = store.presets.find(item => item.id === body?.id)
  if (!preset) throw createError({ statusCode: 404, message: 'Пресет не найден' })
  if (body.action === 'rename') { const nextName = name(body.name), nextDescription = body.description === undefined ? preset.description || '' : description(body.description); preset.name = nextName; preset.description = nextDescription }
  else if (body.action === 'add') {
    if (!Array.isArray(body.packageIds) || body.packageIds.some((id: unknown) => typeof id !== 'string')) throw createError({ statusCode: 400, message: 'Выберите пакеты в библиотеке' })
    const library = getLibraryPackages(), index = indexLibrary(library), refs = new Map(preset.packages.map(item => [presetPackageKey(item), item]))
    for (const id of new Set<string>(body.packageIds)) {
      const pkg = index.id.get(id)
      if (!pkg) throw createError({ statusCode: 409, message: 'Библиотека изменилась. Обновите выбор пакетов.' })
      const ref: PresetPackage = { id: pkg.id, titleId: pkg.titleId, contentId: pkg.contentId, ...(/^[a-f0-9]{64}$/i.test(pkg.packageDigest || '') && !/^0+$/.test(pkg.packageDigest) ? { digest: pkg.packageDigest.toUpperCase() } : {}), fileName: pkg.fileName, title: pkg.title, groupTitle: index.branches.get(pkg.titleId)?.title || pkg.titleId, type: pkg.type, size: pkg.size }
      refs.set(presetPackageKey(ref), ref)
    }
    preset.packages = [...refs.values()]
  } else if (body.action === 'remove') {
    if (!Array.isArray(body.keys) || body.keys.some((key: unknown) => typeof key !== 'string')) throw createError({ statusCode: 400, message: 'Некорректный выбор пакетов' })
    const keys = new Set(body.keys); preset.packages = preset.packages.filter(ref => !keys.has(presetPackageKey(ref)))
  } else throw createError({ statusCode: 400, message: 'Неизвестное действие пресета' })
  preset.updatedAt = Date.now(); writeJsonFile(file, store); return presetSummary(preset)
}
export function deletePreset(id: unknown) {
  assertDesktopWritable(); getPreset(id)
  const store = read(); store.presets = store.presets.filter(item => item.id !== id); writeJsonFile(file, store)
  return { deleted: true }
}
export function exportPresets(id?: unknown) { return { format: 'packageflow-presets', version: 1, presets: id ? [getPreset(id)] : read().presets } }
export function importPresets(body: any) {
  assertDesktopWritable()
  if (body?.format !== 'packageflow-presets' || body.version !== 1 || !Array.isArray(body.presets)) throw createError({ statusCode: 400, message: 'Выберите JSON-файл пресетов PackageFlow' })
  const now = Date.now()
  const imported: Preset[] = body.presets.map((preset: any) => {
    if (!Array.isArray(preset?.packages)) throw createError({ statusCode: 400, message: 'Некорректный состав пресета' })
    const refs = new Map<string, PresetPackage>()
    for (const ref of preset.packages) {
      if (!ref || ['id','titleId','contentId','fileName','title','groupTitle','type'].some(key => typeof ref[key] !== 'string' || ref[key].length > 1024 || /[\x00-\x1f]/.test(ref[key])) || !Number.isSafeInteger(ref.size) || ref.size < 0 || (ref.digest !== undefined && (typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(ref.digest)))) throw createError({ statusCode: 400, message: 'Некорректные сведения о пакете в пресете' })
      const safe: PresetPackage = { id: ref.id, titleId: ref.titleId, contentId: ref.contentId, fileName: ref.fileName, title: ref.title, groupTitle: ref.groupTitle, type: ref.type, size: ref.size, ...(ref.digest ? { digest: ref.digest.toUpperCase() } : {}) }
      refs.set(presetPackageKey(safe), safe)
    }
    return { id: randomUUID(), name: name(preset.name), description: description(preset.description), packages: [...refs.values()], createdAt: now, updatedAt: now }
  })
  const store = read(); store.presets.push(...imported); writeJsonFile(file, store)
  return { imported: imported.length, ids: imported.map(item => item.id) }
}
export function presetSelection(id: unknown, keys?: unknown) {
  const resolved = resolvePreset(getPreset(id))
  if (keys !== undefined && (!Array.isArray(keys) || keys.some(key => typeof key !== 'string') || !keys.length)) throw createError({ statusCode: 400, message: 'Выберите пакеты пресета' })
  const selected = keys === undefined ? resolved : resolved.filter(entry => (keys as string[]).includes(entry.item.key))
  if (keys !== undefined && new Set(keys as string[]).size !== selected.length) throw createError({ statusCode: 409, message: 'Состав пресета изменился. Обновите список.' })
  if (selected.some(entry => !entry.pkg)) throw createError({ statusCode: 409, message: 'Часть пакетов пресета отсутствует в библиотеке. Выберите доступные файлы или добавьте отсутствующие.' })
  if (!selected.length) throw createError({ statusCode: 400, message: 'В пресете нет пакетов' })
  return [...new Map(selected.map(entry => [entry.pkg!.id, entry.pkg!])).values()]
}
