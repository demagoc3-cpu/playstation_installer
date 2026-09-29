import { restartUpdatedService } from '../../../utils/console-maintenance'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); const b = await readBody(event); return restartUpdatedService(b?.ip) })
