import { downloadLatestServicePackage } from '../../../utils/service-updates'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); const b = await readBody(event); return downloadLatestServicePackage(String(b?.current || '0.00')) })
