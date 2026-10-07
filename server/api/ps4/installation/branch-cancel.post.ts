import { cancelGameInstallation } from '../../../utils/installation-queue'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ queueId?: string; gameId?: string; ip?: string }>(event)
  if (!body || [body.queueId, body.gameId, body.ip].some(value => typeof value !== 'string' || !value))
    throw createError({ statusCode: 400, message: 'Укажите очередь, игру и IP приставки' })
  return cancelGameInstallation(body.queueId!, body.ip!, body.gameId!)
})
