import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { fileIp, fileCapabilities } from '../../../utils/console-files'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return fileCapabilities(fileIp(body?.ip))
})
