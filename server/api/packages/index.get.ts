import { inConsoleScope } from '../../utils/console-scope'
import { filterContent } from '../../../shared/content-platform'
import { getLibraryPackages, getDeliveredPackageIds } from '../../utils/package-library'
import { getLocalIp } from '../../utils/ps4-installer'
import { paginateLibrary } from '../../../shared/library-pagination'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const psIp = query.psIp?.toString() || ''
  const pcIp = await getLocalIp(psIp)
  const host = getHeader(event, 'host') || 'localhost:3000'
  const port = host.match(/:(\d+)$/)?.[1] || '3000'
  const shared = query.shared === 'true'
  const result = inConsoleScope(shared ? undefined : psIp || undefined, () => paginateLibrary(filterContent(getLibraryPackages().map(item => shared ? {...item,installedAt:undefined} : item), query.platform, shared ? undefined : query.target), query, shared ? new Set<string>() : getDeliveredPackageIds()))
  return { ...result, packages: result.packages.map(item => ({ ...item, url: `http://${pcIp}:${port}/json/${item.id}.json` })) }
})
