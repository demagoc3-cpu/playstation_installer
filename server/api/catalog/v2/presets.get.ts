import { getConsoleProfile, getConsoleProfiles } from '../../../utils/console-profiles'
import { inConsoleScope } from '../../../utils/console-scope'
import { getLibraryPackages } from '../../../utils/package-library'
import { filterContent, contentPlatform, contentFormat } from '../../../../shared/content-platform'
import { listPresets, getPreset, resolvePreset, presetSummary } from '../../../utils/presets'
import { buildConsoleCatalog } from '../../../utils/console-catalog'
export default defineEventHandler(event => {
  const q = getQuery(event), profile = getConsoleProfile(q.consoleId)
  if (profile.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите профиль PS5' })
  setHeader(event, 'Cache-Control', 'no-store')
  return inConsoleScope(profile.ip, () => {
    const limit = [10,20,30].includes(Number(q.limit)) ? Number(q.limit) : 10
    const requestedOffset = Number(q.offset), offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0, language = q.lang === 'en' ? 'en' : 'ru'
    const snapshot = getConsoleProfiles().consoles.find(item=>item.id === profile.id)!
    const base = { schemaVersion: 2, consoleId: profile.id, consolePlatform: 'ps5', capabilities: { install: snapshot.online && snapshot.paired && snapshot.capabilities.formats.includes('pkg'), download: false, localTorrent: false } }
    const library = filterContent(getLibraryPackages(profile.ip), 'all', 'ps5')
    if (q.presetId) {
      const preset = getPreset(q.presetId), resolved = resolvePreset(preset, library), summary = presetSummary(preset, library)
      const packages = resolved.flatMap(entry => entry.pkg ? [entry.pkg] : []), index = new Map(packages.map(item => [item.id,item]))
      const catalog = buildConsoleCatalog(packages, language, { offset,limit,groupByPlatform:true })
      return { ...catalog, ...base, presetName: preset.name, presetFiles: summary.files, presetSize: summary.size, presetMissing: summary.missing,
        games: catalog.games.map(game => ({ ...game, platform: contentPlatform(index.get(game.packages[0]?.id || '') || {}),
          description: language === 'ru' ? 'Пакеты пресета. Установка зависит от возможностей сервиса PS5.' : 'Preset packages. Installation depends on the PS5 service capabilities.',
          packages: game.packages.map(item => ({ ...item, platform: contentPlatform(index.get(item.id)!), format: contentFormat(index.get(item.id)!) })) })) }
    }
    const page = listPresets({ page: Math.floor(offset / limit)+1, pageSize: limit, q: q.q }), actual = (page.page-1)*limit
    return { ...base, mode:'presets', limit, offset:actual, total:page.total, nextOffset:actual+page.items.length, hasMore:page.page<page.pages,
      games:page.items.map(item => ({ id:item.id,title:item.name,titleId:'',platform:'ps5',description:item.description,cover:'', covers:item.covers.flatMap(cover=>cover.iconId?[`/api/packages/${cover.iconId}?asset=icon`]:[]).slice(0,5), size:item.size,gameCount:item.games,missingCount:item.missing,packageCount:item.files,patchCount:0,dlcCount:0,packages:[] })) }
  })
})
