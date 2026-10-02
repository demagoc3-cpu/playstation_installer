import { startInstallationQueue } from '../../utils/installation-queue'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { getInstallationPreference } from '../../utils/installation-preference'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string; packageIds?: string[]; packageUrls?: Record<string, string>; transport?: unknown }>(event)
  const transport = body?.transport === undefined ? getInstallationPreference() : body.transport
  if (transport === 'service') assertInstallationOrigin(event, true)
  return startInstallationQueue({ psIp: body?.ip || '', packageIds: body?.packageIds || [], packageUrls: body?.packageUrls || {}, transport })
})
