import { nativeCatalogV1 } from '../../../utils/native-catalog-v1'
import type { ConsoleCatalogQuery } from '../../../utils/console-catalog'

// Read-only catalog query. A body keeps the native client's favorite IDs out
// of URLs and avoids URL length limits. Installation uses separate commands.
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const body = await readBody<ConsoleCatalogQuery & { lang?: string }>(event)
  if (!body || typeof body !== 'object' || (body.favoriteIds !== undefined && (!Array.isArray(body.favoriteIds) || body.favoriteIds.length > 1024))) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid catalog query' })
  }
  return nativeCatalogV1(body)
})
