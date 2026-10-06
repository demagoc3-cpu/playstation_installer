import { getLibraryPackages } from '../../../utils/package-library'
import { buildConsoleCatalog } from '../../../utils/console-catalog'

// Metadata only; native actions resolve these IDs on the server. No paths,
// service credentials or invented torrent sources are returned to the app.
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  return buildConsoleCatalog(getLibraryPackages(), query.lang === 'en' ? 'en' : 'ru', query)
})
