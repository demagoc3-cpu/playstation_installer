import { existsSync, readFileSync } from 'node:fs'
import { createError } from 'h3'
import { dataPath } from './data-path'

/** Neither ordinary installation nor service update may race an uncertain bootstrap. */
export function assertNoPs5Bootstrap(id: string) {
  const path=dataPath('console-setup',`bootstrap-${id}.json`)
  if(!existsSync(path))return
  try {
    const f=JSON.parse(readFileSync(path,'utf8'))
    if(f.consoleId===id&&['completed','failed'].includes(f.state))return
  } catch { /* Unknown journals are not safe to replay. */ }
  throw createError({statusCode:409,message:'Первый запуск ELF пока не подтверждён. Проверьте результат в Windows-мастере; новая операция не отправлена'})
}
