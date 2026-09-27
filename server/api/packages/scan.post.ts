import { logEvent } from '../../utils/event-log'
import { scanPackageFolder } from '../../utils/package-library'
import { getLocalIp } from '../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ directory?: string; psIp?: string; titleId?: string }>(event)
  const result = await scanPackageFolder(body?.directory || '', body?.titleId)
  logEvent('info', `Просканирована папка ${result.directory}: найдено пакетов — ${result.packages.length}`)
  const pcIp = await getLocalIp(body?.psIp || '')
  const host = getHeader(event, 'host') || 'localhost:3000'
  const port = host.match(/:(\d+)$/)?.[1] || '3000'
  return { directory: result.directory, packages: result.packages.map((item) => ({ ...item, url: `http://${pcIp}:${port}/json/${item.id}.json` })) }
})
