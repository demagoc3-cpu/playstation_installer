import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { startSaveRestore } from '../../../utils/save-restore-actions'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return startSaveRestore(String(body?.ip || ''), body?.id)
})
