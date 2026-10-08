import { refreshConsoleProfiles } from '../../utils/console-profiles'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(event => { assertInstallationOrigin(event,true); return refreshConsoleProfiles() })
