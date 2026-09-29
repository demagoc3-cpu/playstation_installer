import { submitConsoleRemoval } from '../../../utils/ps4-console-apps'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return submitConsoleRemoval(body?.ip, body)
})
