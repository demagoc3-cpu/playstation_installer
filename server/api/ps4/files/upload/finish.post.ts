import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { consoleFileRequest } from '../../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const id = String(body?.id || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw createError({ statusCode: 400, message: 'Неверный идентификатор загрузки' })
  return consoleFileRequest(body?.ip, 'upload/finish', { id })
})
