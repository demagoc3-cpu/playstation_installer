import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { startSaveSetRestore } from '../../../../utils/save-set-restore'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return startSaveSetRestore(body?.id, body?.ip, body?.targetUserId, body?.selected)
})
