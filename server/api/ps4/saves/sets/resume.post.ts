import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { resumeSaveSet } from '../../../../utils/save-set-store'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return resumeSaveSet(body?.id)
})
