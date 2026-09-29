import { startInstallationQueue } from '../../utils/installation-queue'
import { assertInstallationOrigin } from '../../utils/installation-origin'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string; packageIds?: string[]; packageUrls?: Record<string, string>; transport?: unknown }>(event)
  if (body?.transport === 'service') assertInstallationOrigin(event, true)
  return startInstallationQueue({ psIp: body?.ip || '', packageIds: body?.packageIds || [], packageUrls: body?.packageUrls || {}, transport: body?.transport })
})
