import { appendInstallationQueue } from '../../../utils/installation-queue'
import { assertInstallationOrigin } from '../../../utils/installation-origin'

export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ ip?: string; queueId?: string; packageIds?: string[]; packageUrls?: Record<string, string> }>(event)
  return appendInstallationQueue({ psIp: body?.ip || '', queueId: body?.queueId || '', packageIds: body?.packageIds || [], packageUrls: body?.packageUrls || {} })
})
