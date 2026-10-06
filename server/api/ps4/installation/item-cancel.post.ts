import { cancelInstallationItem } from '../../../utils/installation-queue'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ queueId?: string; packageId?: string; ip?: string }>(event)
  if (!body || [body.queueId, body.packageId, body.ip].some(value => typeof value !== 'string' || !value))
    throw createError({ statusCode: 400, message: 'Укажите очередь, пакет и IP приставки' })
  return cancelInstallationItem(body.queueId!, body.packageId!, body.ip!)
})
