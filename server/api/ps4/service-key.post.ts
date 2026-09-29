import { saveServiceKey } from '../../utils/ps4-service-installer'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ ip?: string; code?: string }>(event)
  return saveServiceKey(body?.ip || '', body?.code)
})
