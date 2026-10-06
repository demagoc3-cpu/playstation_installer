import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { clearFinishedTasks } from '../../../utils/task-visibility'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ torrents?: unknown }>(event)
  return clearFinishedTasks(body?.torrents)
})
