import { submitConsoleControl } from '../../../utils/console-control'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); const b = await readBody(event); return submitConsoleControl(b?.ip, b) })
