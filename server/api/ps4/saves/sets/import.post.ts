import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { importSaveSet } from '../../../../utils/save-set-import'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event)
  return importSaveSet(event)
})
