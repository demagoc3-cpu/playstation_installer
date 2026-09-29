import { cancelInstallationQueue } from '../../../utils/installation-queue'
import { assertInstallationOrigin } from '../../../utils/installation-origin'

export default defineEventHandler(event => { assertInstallationOrigin(event); return cancelInstallationQueue() })
