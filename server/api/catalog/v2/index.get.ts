import { getConsoleProfile, getConsoleProfiles } from '../../../utils/console-profiles'
import { getLibraryPackages } from '../../../utils/package-library'
import { filterContent, contentPlatform, contentFormat } from '../../../../shared/content-platform'
import { buildConsoleCatalog } from '../../../utils/console-catalog'

/** PS5 contract. The legacy PS4 app continues to use catalog/v1. */
export default defineEventHandler(event => {
  const query = getQuery(event), profile = getConsoleProfile(query.consoleId)
  const snapshot = getConsoleProfiles().consoles.find(item => item.id === profile.id)!
  const packages = filterContent(getLibraryPackages(profile.ip), query.platform, profile.platform)
  const favoriteIds = typeof query.favorites === 'string'
    ? query.favorites === 'none' ? [] : query.favorites.split(',').slice(0, 512)
    : query.favoriteIds
  const result = buildConsoleCatalog(packages, query.lang === 'en' ? 'en' : 'ru', { ...query, favoriteIds, groupByPlatform: true })
  const index = new Map(packages.map(item => [item.id, item]))
  setHeader(event, 'Cache-Control', 'no-store')
  return { ...result, schemaVersion: 2, consoleId: profile.id, consolePlatform: profile.platform,
    capabilities: { ...result.capabilities, install: snapshot.online && snapshot.paired && snapshot.capabilities.formats.length > 0, formats: snapshot.capabilities.formats },
    games: result.games.map(game => ({ ...game, description: query.lang === 'en' ? 'Shared WEB library. Installation depends on the console service and supported content format.' : 'Общая библиотека WEB. Установка зависит от сервиса приставки и поддержки формата содержимого.', platform: contentPlatform(index.get(game.packages[0]?.id || '') || {}),
      packages: game.packages.map(item => { const source = index.get(item.id)!; return { ...item, platform: contentPlatform(source), format: contentFormat(source), signature: source.signature || 'unknown' } }) })) }
})
