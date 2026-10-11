import { assertInstallationOrigin } from '../../../utils/installation-origin'
import { ps4ManagementIp } from '../../../utils/console-management-target'
import { removeInstallationTasks } from '../../../utils/task-visibility'
import { stopSelectedReinstall } from '../../../utils/selected-reinstallation'
export default defineEventHandler(async event=>{
 assertInstallationOrigin(event,true)
 const b=await readBody(event),ip=ps4ManagementIp(b?.ip)
 if(typeof b.queueId!=='string'||!b.queueId)throw createError({statusCode:400,message:'Укажите очередь'})
 if(b.action==='stop-reinstall')return stopSelectedReinstall(ip,b.queueId)
 if(!!b.packageIds===!!b.branches||[b.packageIds,b.branches].some(ids=>ids!==undefined&&(!Array.isArray(ids)||!ids.length||ids.length>10000||ids.some((id:unknown)=>typeof id!=='string'||!id))))throw createError({statusCode:400,message:'Неверный выбор заданий'})
 return removeInstallationTasks(ip,b.queueId,b.packageIds,b.branches)
})
