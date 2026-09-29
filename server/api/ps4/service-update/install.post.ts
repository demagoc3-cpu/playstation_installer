import { installServiceArtifact } from '../../../utils/service-updates'
import { getLocalIp } from '../../../utils/ps4-installer'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => { assertInstallationOrigin(event, true); const b = await readBody(event); const pc = await getLocalIp(String(b?.ip || '')); const port = getRequestURL(event).port || '3000'; return installServiceArtifact(b?.ip, String(b?.artifactId || ''), `http://${pc}:${port}`) })
