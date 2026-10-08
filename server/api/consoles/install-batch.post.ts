import { installDeviceBatch } from '../../utils/device-installation'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event,true); const body = await readBody(event); return installDeviceBatch(body?.requestId,body?.selection,body?.consoleIds,getHeader(event,'host') || 'localhost:3000') })
