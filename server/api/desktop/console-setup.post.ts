import { assertDesktopControl } from '../../utils/desktop-control'
import { assertDesktopWritable } from '../../utils/desktop-lifecycle'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { beginDesktopPs5Bootstrap, installDesktopPs5App, removeDesktopPs5App } from '../../utils/desktop-console-setup'
export default defineEventHandler(async event=>{
  assertDesktopControl(event);assertInstallationOrigin(event,true);assertDesktopWritable()
  const body=await readBody(event)
  if(body?.action==='bootstrap')return beginDesktopPs5Bootstrap(body.consoleId,body.firmware,body.confirmedServiceStopped)
  if(body?.action==='install-app')return installDesktopPs5App(body.consoleId,body.requestId)
  if(body?.action==='remove-app')return removeDesktopPs5App(body.consoleId,body.requestId,body.confirmed)
  throw createError({statusCode:400,message:'Неверный шаг установки PS5'})
})
