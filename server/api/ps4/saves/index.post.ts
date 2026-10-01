import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { listSaveUsers } from '../../../utils/ps4-saves'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  return { users: await listSaveUsers(body?.ip) }
})
