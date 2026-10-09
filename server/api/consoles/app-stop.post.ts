import { stopPs5App } from '../../utils/ps5-app-stop'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); return stopPs5App((await readBody(event))?.consoleId) })
