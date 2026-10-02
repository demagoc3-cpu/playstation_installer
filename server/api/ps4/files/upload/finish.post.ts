import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { fileIp, userFilePath, replacementStage, replaceUploadedFile, fileJobs } from '../../../../utils/console-files'
import { consoleFileRequest } from '../../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const id = String(body?.id || '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw createError({ statusCode: 400, message: 'Неверный идентификатор загрузки' })
  if (body?.replace === true) {
    const ip = fileIp(body.ip), path = userFilePath(body.path, true)
    if (fileJobs(ip).jobs.some(j => j.id === id)) return replaceUploadedFile(ip, path, id, body.revision)
    try { await consoleFileRequest(ip, 'stat', { path: replacementStage(path, id) }) } catch (cause: any) {
      if (cause.statusCode !== 404) throw cause
      await consoleFileRequest(ip, 'upload/finish', { id })
    }
    return replaceUploadedFile(ip, path, id, body.revision)
  }
  return consoleFileRequest(body?.ip, 'upload/finish', { id })
})
