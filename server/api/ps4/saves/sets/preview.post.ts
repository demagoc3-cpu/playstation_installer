import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { previewSaveSet } from '../../../../utils/save-set-restore'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return previewSaveSet(body?.id, body?.ip, body?.targetUserId)
})
