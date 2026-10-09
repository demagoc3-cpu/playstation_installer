import { randomBytes } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { createError } from 'h3'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { getConsoleProfile, ps5OperationRequest } from './console-profiles'
import { assertNoPs5ServiceUpdate } from './ps5-service-updates'
interface UiRelease { titleId: string; version: string; metadataHash: string }
interface Launch { requestId: string; titleId: string; version: string; metadataHash: string; startedAt: number; state: 'intent' | 'accepted' | 'running' | 'closed' | 'failed' | 'unconfirmed'; code?: string }
const pending = new Set<string>()
function release(): UiRelease | null {
  try {const r=JSON.parse(readFileSync(dataPath('ps5-ui-release.json'),'utf8'));if(!/^PPSA95\d{3}$/.test(r.titleId)||r.titleId==='PPSA95000'||!/^\d{2}\.\d{3}\.\d{3}$/.test(r.version)||! /^[0-9a-f]{64}$/.test(r.metadataHash))throw Error();return {titleId:r.titleId,version:r.version,metadataHash:r.metadataHash}}
  catch {return null}
}
function profile(id: unknown) {const p=getConsoleProfile(id);if(p.platform!=='ps5')throw createError({statusCode:400,message:'Выберите PS5'});return p}
const path=(id:string)=>dataPath('consoles',id,'ps5-app-launch.json')
function saved(id:string):Launch | null {
  if(!existsSync(path(id)))return null
  try {const v=JSON.parse(readFileSync(path(id),'utf8'));if(!/^[0-9a-f]{32}$/.test(v.requestId)||!/^PPSA95\d{3}$/.test(v.titleId)||! /^[0-9a-f]{64}$/.test(v.metadataHash)||!Number.isSafeInteger(v.startedAt)||!['intent','accepted','running','closed','failed','unconfirmed'].includes(v.state))throw Error();return v}
  catch {throw createError({statusCode:503,message:'Не удалось прочитать результат запуска. Повтор не отправлен'})}
}
export async function ps5AppLaunchInfo(id:unknown) {
  const p=profile(id),target=release();let flow=saved(p.id),available=false,running=false
  try {
    const status=await ps5OperationRequest(p.id,'/api/v1/app/status')
    available=status.status===200 && status.body.available===true;running=available && status.body.running===true
    if(flow && available) {
      const receipt=await ps5OperationRequest(p.id,'/api/v1/app/status',{'X-PackageFlow-Request-Id':flow.requestId})
      if(receipt.status===200 && receipt.body.requestId===flow.requestId && receipt.body.titleId===flow.titleId) {
        if(receipt.body.state==='failed')flow={...flow,state:'failed',code:receipt.body.code}
        else if(receipt.body.state==='accepted')flow={...flow,state:running?'running':flow.state==='running'||flow.state==='closed'?'closed':Date.now()-flow.startedAt>30000?'unconfirmed':'accepted',code:receipt.body.code}
        else flow={...flow,state:'unconfirmed'}
        writeDurableJson(path(p.id),flow)
      } else if(!pending.has(p.id) && ['intent','accepted'].includes(flow.state) && Date.now()-flow.startedAt>30000) {flow={...flow,state:'unconfirmed'};writeDurableJson(path(p.id),flow)}
    }
  } catch { /* A status read never launches anything. */ }
  return {consoleId:p.id,release:target ? {titleId:target.titleId,version:target.version} : null,available,running,flow,message:flow?.state==='failed'?`PS5 отклонила запуск (${flow.code || 'без кода'})`:flow?.state==='unconfirmed'?'Результат запуска неизвестен; повтор не отправлен':!target?'Кандидат приложения ещё не подготовлен':!available?'Обновите службу PS5 для запуска приложения из WEB':running?'PackageFlow запущен':'Приложение можно запустить из WEB'}
}
export async function launchPs5App(id:unknown) {
  const p=profile(id);assertNoPs5ServiceUpdate(p.id)
  if(pending.has(p.id))return ps5AppLaunchInfo(p.id)
  pending.add(p.id)
  try {
  const info=await ps5AppLaunchInfo(p.id),target=release()
  if(!target||!info.available)throw createError({statusCode:409,message:info.message})
  if(info.running||info.flow && ['intent','accepted','unconfirmed'].includes(info.flow.state))return info
  const flow:Launch={...target,requestId:randomBytes(16).toString('hex'),startedAt:Date.now(),state:'intent'}
  writeDurableJson(path(p.id),flow)
  try {
    const reply=await ps5OperationRequest(p.id,'/api/v1/app/launch',{'X-PackageFlow-Request-Id':flow.requestId,'X-PackageFlow-UI-Title':target.titleId,'X-PackageFlow-UI-Metadata-Hash':target.metadataHash})
    if(reply.status!==200||reply.body.requestId!==flow.requestId||reply.body.titleId!==flow.titleId||!['accepted','failed','unconfirmed'].includes(reply.body.state)) {
      writeDurableJson(path(p.id),{...flow,state:[400,401,403,404,409,422].includes(reply.status)?'failed':'unconfirmed'})
      throw createError({statusCode:409,message:reply.status===422||reply.status===404?'Подготовленная версия PackageFlow не найдена на PS5':reply.status===409?'Служба занята или приложение уже открыто':'PS5 не подтвердила запуск приложения'})
    }
    writeDurableJson(path(p.id),{...flow,state:reply.body.state,code:reply.body.code})
  } catch(error) {if(saved(p.id)?.state==='intent')writeDurableJson(path(p.id),{...flow,state:'unconfirmed'});throw error}
  return ps5AppLaunchInfo(p.id)
  } finally {pending.delete(p.id)}
}
