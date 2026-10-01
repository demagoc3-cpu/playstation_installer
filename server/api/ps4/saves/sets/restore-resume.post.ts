import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { resumeSaveSetRestore } from '../../../../utils/save-set-restore'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return resumeSaveSetRestore(body?.id)
})
