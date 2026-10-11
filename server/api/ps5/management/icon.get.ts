import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { ps5ConsoleIcon } from '../../../utils/console-profiles'
export default defineEventHandler(async event=>{assertInstallationOrigin(event);const q=getQuery(event),data=await ps5ConsoleIcon(String(q.consoleId||''),String(q.titleId||''));setHeader(event,'Content-Type','image/png');setHeader(event,'Cache-Control','private, max-age=60');return data})
