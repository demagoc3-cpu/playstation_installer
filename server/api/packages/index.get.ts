import { getLibraryPackages } from '../../utils/package-library'
import { getLocalIp } from '../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const psIp = getQuery(event).psIp?.toString() || ''
  const pcIp = await getLocalIp(psIp)
  const host = getHeader(event, 'host') || 'localhost:3000'
  const port = host.match(/:(\d+)$/)?.[1] || '3000'
  return { packages: getLibraryPackages().map((item) => ({ ...item, url: `http://${pcIp}:${port}/json/${item.id}.json` })) }
})
