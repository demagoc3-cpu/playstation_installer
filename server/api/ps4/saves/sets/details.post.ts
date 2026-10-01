import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { readSaveSet } from '../../../../utils/save-set-store'
import { listSaveSetRestoreRuns } from '../../../../utils/save-set-restore'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  const { set } = readSaveSet(body?.id)
  return { set, runs: listSaveSetRestoreRuns(set.id) }
})
