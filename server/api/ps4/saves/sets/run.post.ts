import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { getSaveSetRestoreRun } from '../../../../utils/save-set-restore'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return getSaveSetRestoreRun(body?.id)
})
