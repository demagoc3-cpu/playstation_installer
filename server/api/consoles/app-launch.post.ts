import { launchPs5App } from '../../utils/ps5-app-launch'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event=>{assertInstallationOrigin(event,true);return launchPs5App((await readBody(event))?.consoleId)})
