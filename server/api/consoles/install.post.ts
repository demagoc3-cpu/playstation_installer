import { getConsoleProfile } from '../../utils/console-profiles'
import { startInstallationQueue, appendInstallationQueue, getInstallationQueue } from '../../utils/installation-queue'
import { libraryInstallationInput, type LibraryInstallationSelection } from '../../utils/library-installation'
import { getPackage } from '../../utils/package-library'
import { getLocalIp } from '../../utils/ps4-installer'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { startPs5Queue } from '../../utils/ps5-installation-queue'

/** The destination is resolved on WEB. A PS5 can never reach the PS4 sender. */
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ consoleId?: string; packageIds?: string[]; librarySelection?: LibraryInstallationSelection; transport?: unknown; queueId?: string }>(event)
  const profile = getConsoleProfile(body?.consoleId)
  if (profile.platform === 'ps5') return startPs5Queue({ consoleId: profile.id, packageIds:body.packageIds, librarySelection:body.librarySelection, queueId:body.queueId })
  const host = getHeader(event, 'host') || 'localhost:3000'
  let input: { packageIds: string[]; packageUrls: Record<string, string> }
  if (body.librarySelection) input = await libraryInstallationInput(body.librarySelection, profile.ip, host)
  else {
    if (!Array.isArray(body.packageIds) || !body.packageIds.length || body.packageIds.length > 10000 || body.packageIds.some(id => typeof id !== 'string')) throw createError({ statusCode: 400, message: 'Выберите пакеты для установки' })
    const ids = [...new Set(body.packageIds)]; ids.forEach(id => getPackage(id))
    const pcIp = await getLocalIp(profile.ip), port = host.match(/:(\d+)$/)?.[1] || '3000'
    input = { packageIds: ids, packageUrls: Object.fromEntries(ids.map(id => [id, `http://${pcIp}:${port}/json/${id}.json`])) }
  }
  if (body.queueId) {
    const queue = getInstallationQueue(profile.ip)
    if (queue.transport !== body.transport) throw createError({ statusCode: 409, message: 'Способ установки очереди изменился' })
    return appendInstallationQueue({ psIp: profile.ip, queueId: body.queueId, ...input })
  }
  return startInstallationQueue({ psIp: profile.ip, ...input, transport: body.transport })
})
