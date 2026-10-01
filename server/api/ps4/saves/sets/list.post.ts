import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { listSaveSets } from '../../../../utils/save-set-store'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  return { sets: listSaveSets() }
})
