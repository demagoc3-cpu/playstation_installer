import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { submitPs5AppCommand } from '../../../utils/ps5-app-commands'
export default defineEventHandler(async event => { assertInstallationOrigin(event,true); return submitPs5AppCommand(await readBody(event), getRequestURL(event).host) })
