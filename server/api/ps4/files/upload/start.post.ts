import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { fileIp, userFilePath, replacementStage } from '../../../../utils/console-files'
import { consoleFilePath, consoleFileRequest } from '../../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const size = Number(body?.size)
  const id = String(body?.id || '')
  if (!Number.isSafeInteger(size) || size < 0 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw createError({ statusCode: 400, message: 'Недопустимый файл или идентификатор загрузки' })
  const ip = fileIp(body?.ip), path = userFilePath(body?.path, true)
  if (body?.replace === true) {
    const current = await consoleFileRequest(ip, 'stat', { path }) as { revision: string; writable: boolean; type: string }
    if (!current.writable || current.type !== 'file' || current.revision !== body.revision) throw createError({ statusCode: 409, message: 'Файл изменился. Подтвердите замену заново' })
    const staging = replacementStage(path, id)
    try {
      const staged = await consoleFileRequest(ip, 'stat', { path: staging }) as { size: number }
      if (staged.size !== size) throw createError({ statusCode: 409, message: 'Размер подготовленного файла изменился' })
      return { offset: size }
    } catch (cause: any) { if (cause.statusCode !== 404) throw cause }
    return consoleFileRequest(ip, 'upload/start', { path: staging, id, size })
  }
  return consoleFileRequest(ip, 'upload/start', { path: consoleFilePath(path), id, size })
})
