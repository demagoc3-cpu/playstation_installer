import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { consoleFilePath, consoleFileRequest } from '../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const path = consoleFilePath(body?.path)
  const offset = Number(body?.offset ?? 0)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) throw createError({ statusCode: 400, message: 'Неверная страница папки' })
  const result = await consoleFileRequest(body?.ip, 'list', { path, offset }) as { entries?: { name: string }[] }
  if (Array.isArray(result.entries)) result.entries = result.entries.filter(entry => entry.name !== 'web-key')
  return result
})
