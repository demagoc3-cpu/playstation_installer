import { legacyConsoleIp } from '../../../utils/console-scope'
import { filterContent } from '../../../../shared/content-platform'
import { getLibraryPackages } from '../../../utils/package-library'
import { buildConsoleCatalog } from '../../../utils/console-catalog'
import { nativeInstallReviewCapability } from '../../../utils/native-install-review'

// Metadata only; native actions resolve these IDs on the server. No paths,
// service credentials or invented torrent sources are returned to the app.
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event)
  const result = buildConsoleCatalog(filterContent(getLibraryPackages(query.ip?.toString() || legacyConsoleIp()), 'ps4'), query.lang === 'en' ? 'en' : 'ru', query)
  return { ...result, capabilities: { ...result.capabilities, installReview: nativeInstallReviewCapability() } }
})
