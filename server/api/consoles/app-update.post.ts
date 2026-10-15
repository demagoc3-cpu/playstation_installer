import { assertInstallationOrigin } from '../../utils/installation-origin'
import { assertDesktopWritable } from '../../utils/desktop-lifecycle'
import { beginPs5AppUpdate } from '../../utils/ps5-app-updates'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  assertDesktopWritable()
  return beginPs5AppUpdate((await readBody(event))?.consoleId)
})
