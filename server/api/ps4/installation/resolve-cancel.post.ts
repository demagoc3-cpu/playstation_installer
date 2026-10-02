import { readBody } from 'h3'
import { resolveCancelledQueue } from '../../../utils/installation-queue'
import { assertInstallationOrigin } from '../../../utils/installation-origin'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event)
  const body = await readBody(event)
  if (!body || typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/.test(body.id))
    throw createError({ statusCode: 400, message: 'Неизвестная очередь установки' })
  return resolveCancelledQueue(body.id)
})
