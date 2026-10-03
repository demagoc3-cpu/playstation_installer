import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { submitConsoleCommand } from '../../../utils/console-app-commands'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const port = getRequestURL(event).port || '3000'
  return submitConsoleCommand(await readBody(event), port)
})
