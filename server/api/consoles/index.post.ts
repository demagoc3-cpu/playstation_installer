import { saveConsoleProfile } from '../../utils/console-profiles'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  return saveConsoleProfile(await readBody(event))
})
