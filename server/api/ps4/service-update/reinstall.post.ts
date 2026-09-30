import { reinstallMissingLauncher } from '../../../utils/console-maintenance'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); const body = await readBody(event); return reinstallMissingLauncher(body?.ip) })
