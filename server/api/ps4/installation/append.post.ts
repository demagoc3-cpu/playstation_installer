import { appendInstallationQueue } from '../../../utils/installation-queue'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { libraryInstallationInput, type LibraryInstallationSelection } from '../../../utils/library-installation'

export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ ip?: string; queueId?: string; packageIds?: string[]; packageUrls?: Record<string, string>; librarySelection?: LibraryInstallationSelection }>(event)
  if (body?.librarySelection) {
    const input = await libraryInstallationInput(body.librarySelection, body.ip || '', getHeader(event, 'host') || 'localhost:3000')
    return appendInstallationQueue({ psIp: body.ip || '', queueId: body.queueId || '', ...input })
  }
  return appendInstallationQueue({ psIp: body?.ip || '', queueId: body?.queueId || '', packageIds: body?.packageIds || [], packageUrls: body?.packageUrls || {} })
})
