import { startInstallationQueue } from '../../utils/installation-queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string; packageIds?: string[]; packageUrls?: Record<string, string> }>(event)
  return startInstallationQueue({ psIp: body?.ip || '', packageIds: body?.packageIds || [], packageUrls: body?.packageUrls || {} })
})
