import { getLibraryPackages } from '../../../utils/package-library'
import { buildConsoleCatalog, type ConsoleCatalogQuery } from '../../../utils/console-catalog'

// Read-only catalog query. A body keeps the native client's favorite IDs out
// of URLs and avoids URL length limits. Installation uses separate commands.
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = await readBody<ConsoleCatalogQuery & { lang?: string }>(event)
  if (!body || typeof body !== 'object' || (body.favoriteIds !== undefined && (!Array.isArray(body.favoriteIds) || body.favoriteIds.length > 1024))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid catalog query' })
  }
  return buildConsoleCatalog(getLibraryPackages(), body.lang === 'en' ? 'en' : 'ru', body)
})
