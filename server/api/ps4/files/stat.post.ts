import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { consoleFilePath, consoleFileRequest } from '../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return consoleFileRequest(body?.ip, 'stat', { path: consoleFilePath(body?.path) })
})
