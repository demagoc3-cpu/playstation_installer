import { createError } from 'h3'
import { getConsoleProfile, removeConsoleProfile } from './console-profiles'
import { getInstallationQueue } from './installation-queue'
import { getPs5Queue } from './ps5-installation-queue'
import { desktopActivity } from './desktop-control'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dataPath } from './data-path'

function pendingPs5Journal(id: string) {
  for(const [folder,terminal] of [
    ['ps5-save-restores',['failed','confirmed','rolled-back']],
    ['ps5-save-jobs',['failed','complete']],
    ['ps5-game-commands',['failed','accepted']],
    ['ps5-service-updates',['failed','completed']],
  ] as const) {
    const path=dataPath(folder)
    if(!existsSync(path))continue
    for(const file of readdirSync(path).filter(name=>/^[a-f0-9]{32}\.json$/.test(name))) {
      let record:any
      try {record=JSON.parse(readFileSync(dataPath(folder,file),'utf8'))}
      catch {throw createError({statusCode:503,message:'Не удалось проверить незавершённые операции. Устройство не удалено'})}
      if(record.consoleId===id&&!(terminal as readonly string[]).includes(record.state))return true
    }
  }
  return false
}

/** Forget this WEB/Windows client; console-side trust and files are preserved. */
export function forgetConsole(id: unknown, confirmed: unknown) {
  if (confirmed !== true) throw createError({statusCode:400,message:'Подтвердите удаление устройства'})
  const p=getConsoleProfile(id)
  const queue=p.platform==='ps5'?getPs5Queue(p.id):getInstallationQueue(p.ip)
  if (desktopActivity().busy || p.platform==='ps5'&&pendingPs5Journal(p.id) || queue.items.some(item=>!['installed','failed','skipped','cancelled'].includes(item.state)))
    throw createError({statusCode:409,message:'Сначала завершите или отмените задания, затем удалите устройство'})
  const profiles=removeConsoleProfile(p.id)
  return {profiles,remotePairing:'unchanged',message:'Устройство и ключ удалены из этого Windows/WEB. Данные приставки сохранены. Для нового подключения выберите найденную приставку и нажмите «Подключить».'}
}
