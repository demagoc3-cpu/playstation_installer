import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { readConsoleText, saveConsoleText } from '../../../utils/console-files'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  if (body?.action === 'read') return readConsoleText(body.ip, body.path)
  if (body?.action === 'save') return saveConsoleText(body.ip, body)
  throw createError({ statusCode: 400, message: 'Неизвестная команда редактора' })
})
