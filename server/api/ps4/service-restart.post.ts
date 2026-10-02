import { randomUUID } from 'node:crypto'
import { assertInstallationOrigin } from '../../utils/installation-origin'
import { submitConsoleControl } from '../../utils/console-control'
import { getActiveServiceInstallJob } from '../../utils/ps4-service-installer'
import { ps4ServiceIp } from '../../utils/ps4-service'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody<{ ip?: string }>(event)
  const ip = ps4ServiceIp(body?.ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  if (await getActiveServiceInstallJob(ip)) throw createError({ statusCode: 409, message: 'Сначала завершите или освободите задание установки.' })
  const result = await submitConsoleControl(ip, { requestId: randomUUID(), titleId: 'PFLS00001', action: 'restart', expected: '00000000-0000-0000-0000-000000000000' }, true)
  return { result, message: 'Перезапуск запрошен. Подождите ответа новой службы.' }
})
