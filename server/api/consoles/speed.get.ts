import { consoleSpeedInfo, consoleSpeedJob } from '../../utils/console-speed'
export default defineEventHandler(async event => { const q=getQuery(event);if(typeof q.consoleId!=='string')throw createError({statusCode:400,message:'Выберите приставку'});return typeof q.id==='string'?consoleSpeedJob(q.consoleId,q.id):consoleSpeedInfo(q.consoleId) })
