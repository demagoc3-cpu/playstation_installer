import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { consoleFilePath, consoleFileRequest } from '../../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const size = Number(body?.size)
  const id = String(body?.id || '')
  if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw createError({ statusCode: 400, message: 'Недопустимый файл или идентификатор загрузки' })
  return consoleFileRequest(body?.ip, 'upload/start', { path: consoleFilePath(body?.path), id, size })
})
