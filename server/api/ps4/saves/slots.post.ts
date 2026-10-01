import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { listSaveSlots } from '../../../utils/ps4-saves'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return { slots: await listSaveSlots(body?.ip, body?.userId, body?.titleId) }
})
