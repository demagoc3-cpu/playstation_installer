import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createError } from 'h3'
import { getConsoleProfile } from './console-profiles'
import { getLibraryPackages } from './package-library'
import { getPs5Queue, startPs5Queue, cancelPs5Queue, clearPs5Tasks, ps5TaskPackageId, removePs5Tasks } from './ps5-installation-queue'
import { normalizeNativeTaskControl, normalizeNativeInstallReview } from './native-task-contract'
import { presetSelection } from './presets'
import { inConsoleScope } from './console-scope'
import { contentBranchKey, contentForConsole } from '../../shared/content-platform'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
interface Receipt { id: string; fingerprint: string; state: 'pending'|'completed'|'failed'|'uncertain'; message: string; createdAt: number; queueId?: string }
const pending = new Set<string>()
const path = (id: string) => dataPath(`consoles/${id}/ps5-command-receipts.json`)
function receipts(id: string): Record<string,Receipt> {
  if (!existsSync(path(id))) return {}
  try { const value = JSON.parse(readFileSync(path(id),'utf8')); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value }
  catch { throw createError({ statusCode:500,message:'Не удалось прочитать результаты команд PS5. Сохранённый файл не изменён' }) }
}
export function ps5AppCommand(consoleId: unknown, id: unknown) {
  const p = getConsoleProfile(consoleId)
  if (p.platform !== 'ps5' || typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) throw createError({ statusCode:400,message:'Неверная команда PS5' })
  const receipt = receipts(p.id)[id]
  if (!receipt) throw createError({ statusCode:404,message:'Команда не найдена' })
  const { fingerprint: _, ...result } = receipt
  if (receipt.state === 'pending' && !pending.has(`${p.id}:${id}`)) return { ...result, state:'uncertain', message:'WEB перезапустился во время команды. Обновите задания; автоматический повтор не выполнялся' }
  return result
}
export function submitPs5AppCommand(body: any, host = 'localhost:3000') {
  // Snapshot scalar identity as well as normalized arrays before any await.
  body = { ...body }
  const p = getConsoleProfile(body?.consoleId)
  const actions = ['selected','all','patches','dlc','install-preset','install-favorites','clear-tasks','cancel-current','cancel-all','cancel-game','cancel-item','cancel-items','cancel-games','reinstall-preview','reinstall','remove-items','remove-games','install-reviewed']
  if (p.platform !== 'ps5' || !/^[0-9a-f]{32}$/.test(body?.requestId || '') || !actions.includes(body?.action)) throw createError({ statusCode:400,message:'Неверная команда PS5' })
  const taskControl = normalizeNativeTaskControl(body, 'ps5')
  const review = body.action === 'install-reviewed' ? normalizeNativeInstallReview(body) : undefined
  const list = (input: unknown, limit: number) => {
    if (input === undefined) return []
    if (!Array.isArray(input) || input.length > limit || input.some(id=>typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id))) throw createError({statusCode:400,message:'Неверный список пакетов'})
    return [...new Set(input as string[])].sort()
  }
  const command = { action:body.action, gameId:typeof body.gameId === 'string' ? body.gameId : '', presetId:typeof body.presetId === 'string' ? body.presetId : '',
    queueId:typeof body.queueId === 'string' ? body.queueId : '', currentPackageId:typeof body.currentPackageId === 'string' ? body.currentPackageId : '',
    packageIds:list(body.packageIds,10000), gameIds:list(body.gameIds,10000), favoriteIds:list(body.favoriteIds,512),
    ...(review ? { reviewToken: review.reviewToken, overwritePackageIds: review.overwritePackageIds } : {}) }
  if ([command.gameId,command.presetId,command.queueId,command.currentPackageId].some(value=>value.length>128 || /[^a-zA-Z0-9_.:-]/.test(value))) throw createError({statusCode:400,message:'Неверный идентификатор'})
  const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex'), saved = receipts(p.id), old = saved[body.requestId]
  if (old) { if (old.fingerprint !== fingerprint) throw createError({statusCode:409,message:'Идентификатор команды уже использован'}); return ps5AppCommand(p.id,body.requestId) }
  // Keep receipts: dropping old IDs would allow a delayed retry to dispatch again.
  saved[body.requestId] = { id:body.requestId,fingerprint,state:'pending',message:'Команда принята WEB',createdAt:Date.now() }
  writeDurableJson(path(p.id),saved); pending.add(`${p.id}:${body.requestId}`)
  void (async () => {
    let queueId: string | undefined, state: Receipt['state'] = 'completed', message = 'Команда выполнена'
    try {
      if (review) {
        const { submitNativeInstallReview } = await import('./native-install-review')
        const result = await submitNativeInstallReview({ ...command, consoleId: p.id, requestId: body.requestId }, 'ps5', host)
        queueId = result.queueId; message = result.message
        if (result.state !== 'queued') state = result.state === 'uncertain' ? 'uncertain' : 'failed'
      } else if (taskControl) {
        const result = removePs5Tasks(p.id, command.queueId, command.action === 'remove-items' ? command.packageIds : undefined, command.action === 'remove-games' ? command.gameIds : undefined)
        queueId = command.queueId; message = result.message
      } else if (command.action === 'clear-tasks') { clearPs5Tasks(p.id); message = 'Завершённые задания и ошибки убраны из списка' }
      else if (command.action.startsWith('cancel-')) {
        const queue = getPs5Queue(p.id)
        if (queue.id !== command.queueId) throw new Error('Очередь изменилась. Обновите задания')
        let packages: string[] | undefined, branches: string[] | undefined
        if (['cancel-current','cancel-item'].includes(command.action)) {
          packages = [ps5TaskPackageId(p.id,command.queueId,command.currentPackageId)]
        } else if (command.action === 'cancel-items') {
          // Resolve opaque task IDs against the full queue, never a visible page.
          packages = command.packageIds.map(id=>ps5TaskPackageId(p.id,command.queueId,id))
          if (!packages.length) throw new Error('Выберите задания')
        } else if (['cancel-game','cancel-games'].includes(command.action)) {
          const ids = command.action==='cancel-game' ? [command.gameId] : command.gameIds
          if (!ids.length) throw new Error('Выберите ветки')
          branches = ids.map(id=> { const item=queue.items.find(item=>item.branch===id || item.titleId===id); if(!item) throw new Error('Ветка больше не существует'); return item.branch })
        }
        const result=cancelPs5Queue(p.id,command.queueId,packages,branches); queueId=result.id; message=result.message
      } else if (command.action.startsWith('reinstall')) throw new Error('Переустановка с удалением ещё не проверена на PS5')
      else {
        const library=getLibraryPackages(p.ip).filter(item=>contentForConsole(item,'ps5'))
        let ids: string[]
        if (command.action==='install-preset') ids=inConsoleScope(p.ip,()=>presetSelection(command.presetId || command.gameId)).map(item=>item.id)
        else if (command.action==='install-favorites') {
          if (!command.favoriteIds.length) throw new Error('Избранное пусто')
          const branches=command.favoriteIds.map(id=>{const item=library.find(item=>contentBranchKey(item)===id || item.id===id || item.titleId===id || item.sourceIds?.includes(id)); if(!item) throw new Error('Избранная игра отсутствует в библиотеке. Обновите список'); return contentBranchKey(item)})
          ids=library.filter(item=>branches.includes(contentBranchKey(item))).map(item=>item.id)
        } else {
          const branch=library.filter(item=>contentBranchKey(item)===command.gameId)
          if (!branch.length) throw new Error('Игра не найдена')
          if (command.action==='selected' && (!command.packageIds.length || command.packageIds.some(id=>!branch.some(item=>item.id===id)))) throw new Error('Выбранные пакеты больше не входят в эту игру')
          ids=branch.filter(item=> command.action==='selected' ? command.packageIds.includes(item.id) : command.action==='patches' ? item.installOrder===1 : command.action==='dlc' ? item.type==='DLC' : true).map(item=>item.id)
        }
        const current=getPs5Queue(p.id), result=await startPs5Queue({consoleId:p.id,packageIds:ids,queueId:current.status==='running'?current.id:undefined})
        queueId=result.id; message='Пакеты добавлены в очередь PS5'
      }
    } catch (error:any) { state='failed'; message=error?.data?.message || error?.message || 'Команда PS5 не выполнена' }
    finally { const latest=receipts(p.id); latest[body.requestId]={...saved[body.requestId]!,state,message,queueId}; writeDurableJson(path(p.id),latest); pending.delete(`${p.id}:${body.requestId}`) }
  })().catch(()=> { pending.delete(`${p.id}:${body.requestId}`) })
  return ps5AppCommand(p.id,body.requestId)
}
