import { startInstallationQueue } from '../../utils/installation-queue'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getInstallationPreference } from '../../utils/installation-preference'
import { libraryInstallationInput, type LibraryInstallationSelection } from '../../utils/library-installation'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string; packageIds?: string[]; packageUrls?: Record<string, string>; transport?: unknown; librarySelection?: LibraryInstallationSelection }>(event)
  const transport = body?.transport === undefined ? getInstallationPreference() : body.transport
  if (transport === 'service') assertInstallationOrigin(event, true)
  if (body?.librarySelection) {
    const input = await libraryInstallationInput(body.librarySelection, body.ip || '', getHeader(event, 'host') || 'localhost:3000')
    return startInstallationQueue({ psIp: body.ip || '', ...input, transport })
  }
  return startInstallationQueue({ psIp: body?.ip || '', packageIds: body?.packageIds || [], packageUrls: body?.packageUrls || {}, transport })
})
