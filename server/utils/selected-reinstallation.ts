import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { getConsoleDetails, getConsoleRemoval, submitConsoleRemoval } from './ps4-console-apps'
import { consoleRuntime } from './console-control'
import { assertNoMaintenance, readMaintenance, saveMaintenance } from './maintenance-store'
import { assertNoInstallation, assertNoRemoval } from './console-operation-store'
import { statSync } from 'node:fs'
import { checkPs4Firmware } from './installation-firmware'
import { getPackage, readPackageMetadata } from './package-library'
import { startInstallationQueue, getInstallationQueue, peekInstallationQueue, cancelInstallationQueue } from './installation-queue'
import type { ConsoleComponent } from '../../shared/types/console-apps'
import { claimConsoleWorker } from './console-worker-lock'

const fail=(message:string)=>createError({statusCode:409,message})
const identity=(c:ConsoleComponent)=>JSON.stringify([c.id,c.kind,c.contentId,c.version,c.sizeBytes,c.storage])
export interface ReinstallStep { titleId:string; revision:string; expected:ConsoleComponent[]; kind:'game'|'patch'|'dlc'; componentId:string; affected:ConsoleComponent[]; requestId:string }
/** Full-game deletion is allowed only if every affected component is selected for replacement. */
export function replacementCoversComponents(components:Array<{kind:string;contentId:string}>, packages:Array<{contentId:string;installOrder:number;type:string}>) {
 return components.every(c=>packages.some(p=>(c.kind==='base'?p.installOrder===0:c.kind==='patch'?p.installOrder===1&&p.type!=='DLC':p.type==='DLC')&&p.contentId===c.contentId))
}
async function verifyReinstallSources(ip:string,ids:string[]){
 const sources=[]
 for(const pkg of ids.map(getPackage)){
  const actual=await readPackageMetadata(pkg.path,pkg.fileName),st=statSync(pkg.path)
  if(actual.titleId!==pkg.titleId||actual.contentId!==pkg.contentId||actual.contentType!==pkg.contentType||actual.appVersion!==pkg.appVersion||st.size!==pkg.size)throw fail('PKG изменился после сканирования. Обновите библиотеку перед переустановкой')
  const firmware=await checkPs4Firmware(ip,actual)
  if(firmware.state!=='compatible')throw fail(firmware.detail)
  sources.push({id:pkg.id,path:pkg.path,size:st.size,modified:st.mtimeMs})
 }
 return sources
}
export async function selectedReinstallPlan(ip:string, approvedIds:string[]):Promise<ReinstallStep[]> {
 const packages=approvedIds.map(getPackage),steps:ReinstallStep[]=[]
 await verifyReinstallSources(ip,approvedIds)
 for(const titleId of [...new Set(packages.map(p=>p.titleId))]){
  const details=await getConsoleDetails(ip,titleId), selected=packages.filter(p=>p.titleId===titleId)
  if(!details.complete||details.app.protected)throw fail('Состав игры не подтверждён для переустановки')
  if((await consoleRuntime(ip,titleId)).running)throw fail('Перед переустановкой остановите игру в разделе «На консоли»')
  let remaining=[...details.components]
  if(selected.some(p=>p.installOrder===0)){
   if(!replacementCoversComponents(remaining,selected))throw fail('Переустановка базы удаляет её патчи и DLC. Выберите для переустановки все затронутые компоненты')
   if(remaining.some(c=>!c.canRemove))throw fail('PS4 не разрешает удаление одного из компонентов')
   steps.push({titleId,revision:details.revision,expected:remaining,kind:'game',componentId:'all',affected:remaining,requestId:randomUUID()})
  }else for(const pkg of selected){
   const kind=pkg.type==='DLC'?'dlc':'patch',componentId=kind==='dlc'?pkg.contentId.slice(20):'patch'
   if(steps.some(s=>s.titleId===titleId&&s.kind===kind&&s.componentId===componentId))continue
   const affected=remaining.filter(c=>c.kind===kind&&c.id===componentId)
   if(!affected.length||affected.some(c=>!c.canRemove))throw fail('Выбранный компонент на PS4 изменился; обновите подтверждение')
   steps.push({titleId,revision:details.revision,expected:[...remaining],kind,componentId,affected,requestId:randomUUID()})
   remaining=remaining.filter(c=>!affected.includes(c))
  }
 }
 return steps
}
function persist(ip:string,flow:any){const all=readMaintenance();if(all[ip]?.id===flow.id&&all[ip].cancelRequested)flow.cancelRequested=true;all[ip]=flow;saveMaintenance(all)}
/** Stop future removals/installs; an accepted removal is only observed, never repeated. */
export async function stopSelectedReinstall(ip:string,id:string){
 const flow=readMaintenance()[ip]
 if(!flow||flow.id!==id||flow.kind!=='selected-reinstall')throw fail('Переустановка изменилась. Обновите задания')
 if(['completed','failed'].includes(flow.state))return {message:flow.message}
 flow.cancelRequested=true;persist(ip,flow)
 const result=await advanceSelectedReinstall(ip,flow)
 return {message:result.message || 'Остановка переустановки запрошена'}
}
export async function beginSelectedReinstall(ip:string,input:{packageIds:string[];packageUrls:Record<string,string>},steps:ReinstallStep[]){
 assertNoMaintenance(ip);assertNoInstallation(ip);assertNoRemoval(ip)
 const sources=await verifyReinstallSources(ip,input.packageIds)
 assertNoMaintenance(ip);assertNoInstallation(ip);assertNoRemoval(ip)
 const flow:any={sources,id:randomUUID(),kind:'selected-reinstall',state:'removing',input,steps,index:0,message:'Переустановка подтверждена. Удаляем только выбранные компоненты',createdAt:Date.now()}
 persist(ip,flow)
 await advanceSelectedReinstall(ip,flow)
 if(flow.state==='failed')throw fail(flow.message)
 return {id:flow.id}
}
const locks=new Set<string>()
export async function advanceSelectedReinstall(ip:string,flow=readMaintenance()[ip]){
 if(!flow||flow.kind!=='selected-reinstall'||['completed','failed'].includes(flow.state)||locks.has(ip))return flow
 const releaseWorker=claimConsoleWorker('reinstall',ip)
 if(!releaseWorker)return flow
 locks.add(ip)
 try{
  if(flow.cancelRequested){
   const queue=peekInstallationQueue(ip)
   if(queue.id===flow.id&&['running','cancelling'].includes(queue.status)){
    cancelInstallationQueue(ip);flow.message='Останавливаем переустановку; ждём подтверждения отмены пакета PS4';return flow
   }
   const step=flow.steps[flow.index]
   if(flow.state!=='installing'&&step?.dispatched){
    const removal=await getConsoleRemoval(ip,step.requestId)
    if(!removal||!['removed','failed','partial'].includes(removal.state)){flow.message='Переустановка остановлена. Проверяем уже отправленное удаление; следующие команды не отправляются';return flow}
   }
   flow.state='failed';flow.message='Переустановка остановлена пользователем. Следующие удаления и установки не отправлены';return flow
  }
  if(flow.state==='installing'){
   const queue=getInstallationQueue(ip)
   if(queue.id!==flow.id)throw fail('Очередь переустановки изменилась. Повтор не отправлен')
   flow.message=queue.message
   if(['completed','failed','cancelled'].includes(queue.status))flow.state=queue.status==='completed'&&queue.items.every(item=>item.state==='installed'||item.state==='skipped'&&!!item.installedAt)?'completed':'failed'
   return flow
  }
  const step=flow.steps[flow.index]
  if(step){
   if(!step.dispatched){
    for(const source of flow.sources || []){
      const pkg=getPackage(source.id),st=statSync(pkg.path)
      if(pkg.path!==source.path||st.size!==source.size||st.mtimeMs!==source.modified)throw fail('Исходные файлы изменились перед удалением. Установка не началась')
    }
    const details=await getConsoleDetails(ip,step.titleId)
    if(!details.complete||details.app.protected||JSON.stringify(details.components.map(identity).sort())!==JSON.stringify(step.expected.map(identity).sort()))throw fail('Состав игры изменился перед удалением; повторно подтвердите переустановку')
    if(!flow.steps.slice(0,flow.index).some((previous:ReinstallStep)=>previous.titleId===step.titleId)&&details.revision!==step.revision)throw fail('Состав игры изменился после подтверждения')
    if((await consoleRuntime(ip,step.titleId)).running)throw fail('Остановите игру перед переустановкой')
    if(readMaintenance()[ip]?.cancelRequested){flow.cancelRequested=true;return flow}
    step.dispatched=true;step.actualRevision=details.revision;persist(ip,flow)
    await submitConsoleRemoval(ip,{requestId:step.requestId,titleId:step.titleId,kind:step.kind,componentId:step.componentId,revision:step.actualRevision,confirmTitleId:step.titleId},flow.id)
   }
   const removal=await getConsoleRemoval(ip,step.requestId)
   if(readMaintenance()[ip]?.cancelRequested){flow.cancelRequested=true;return flow}
   if(!removal||['failed','partial','uncertain'].includes(removal.state)){
    flow.state=removal?.state==='failed'||removal?.state==='partial'?'failed':'uncertain';flow.message='Удаление не подтверждено. Установка не отправлена; проверяем прежнюю команду';return flow
   }
   if(removal.state!=='removed')return flow
   flow.index++
   if(flow.index<flow.steps.length)return flow
  }
  // Persist dispatch intent before starting the exact, frozen selection. Recover by queue ID.
  if(readMaintenance()[ip]?.cancelRequested){flow.cancelRequested=true;return flow}
  flow.state='installing';flow.message='Удаление подтверждено. Устанавливаем выбранный набор';persist(ip,flow)
  startInstallationQueue({psIp:ip,...flow.input,transport:'service',maintenanceId:flow.id})
 }catch(error:any){flow.state='failed';flow.message=error?.message||'Не удалось завершить переустановку'}
 finally{try{persist(ip,flow)}finally{locks.delete(ip);releaseWorker()}}
 return flow
}
