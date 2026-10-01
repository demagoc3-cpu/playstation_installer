import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { createSaveBackup } from '../../../utils/ps4-saves'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return createSaveBackup(String(body?.ip || ''), body?.userId, body?.titleId, body?.slot)
})
