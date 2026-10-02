import { assertInstallationOrigin } from '../../utils/installation-origin'
import { setInstallationPreference } from '../../utils/installation-preference'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return { transport: setInstallationPreference(body?.transport) }
})
