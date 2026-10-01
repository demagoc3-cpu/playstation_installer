import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { createSaveSet } from '../../../../utils/save-set-store'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return createSaveSet(body?.name, body?.ip)
})
