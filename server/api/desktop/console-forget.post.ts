import { assertDesktopControl } from '../../utils/desktop-control'
import { assertDesktopWritable } from '../../utils/desktop-lifecycle'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { forgetConsole } from '../../utils/console-forget'
export default defineEventHandler(async event=>{
  assertDesktopControl(event);assertInstallationOrigin(event,true);assertDesktopWritable()
  const body=await readBody(event)
  return forgetConsole(body?.consoleId,body?.confirmed)
})
