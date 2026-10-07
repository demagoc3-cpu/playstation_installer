import { listPresets, getPreset, resolvePreset, presetSummary } from '../../../utils/presets'
import { buildConsoleCatalog } from '../../../utils/console-catalog'
import { getLibraryPackages } from '../../../utils/package-library'
export default defineEventHandler(async event => {
  const body = await readBody<{ presetId?: string; offset?: number; limit?: number; lang?: string }>(event)
  const limit = [10, 20, 30].includes(Number(body?.limit)) ? Number(body.limit) : 20, offset = Math.max(0, Math.floor(Number(body?.offset) || 0)), language = body?.lang === 'en' ? 'en' : 'ru'
  setHeader(event, 'Cache-Control', 'no-store')
  if (body?.presetId) {
    const preset = getPreset(body.presetId), library = getLibraryPackages()
    const resolved = resolvePreset(preset, library), summary = presetSummary(preset, library)
    return { ...buildConsoleCatalog(resolved.flatMap(entry => entry.pkg ? [entry.pkg] : []), language, { offset, limit }), presetName: preset.name, presetFiles: summary.files, presetSize: summary.size, presetMissing: summary.missing }
  }
  const page = listPresets({ page: Math.floor(offset / limit) + 1, pageSize: limit }), actualOffset = (page.page - 1) * limit
  return { schemaVersion: 1, mode: 'presets', offset: actualOffset, total: page.total, nextOffset: actualOffset + page.items.length, hasMore: page.page < page.pages,
    games: page.items.map(item => ({ id: item.id, title: item.name, titleId: '', cover: item.covers[0]?.iconId ? `/api/packages/${item.covers[0].iconId}?asset=icon` : '', covers: item.covers.flatMap(cover => cover.iconId ? [`/api/packages/${cover.iconId}?asset=icon`] : []).slice(0, 5), size: item.size, gameCount: item.games, missingCount: item.missing, packageCount: item.files, patchCount: 0, dlcCount: 0, packages: [],
      description: language === 'ru' ? `${item.games} игр • ${item.files} файлов • ${(item.size / 1073741824).toFixed(2)} ГБ • Недоступно: ${item.missing}` : `${item.games} games • ${item.files} files • ${(item.size / 1073741824).toFixed(2)} GB • Missing: ${item.missing}` })) }
})
