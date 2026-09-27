import { logEvent } from '../../utils/event-log'
import { getGoldHenStatus, savePsIp } from '../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string }>(event)
  const ip = body?.ip?.trim() || ''
  const status = await getGoldHenStatus(ip)
  // Remember the address the user connected to, even if the console is asleep right now.
  savePsIp(ip)
  if (status.ready) logEvent('info', `PS4 ${ip}: загрузчик на порту 9090 готов`)
  else logEvent('warn', `PS4 ${ip}: загрузчик на порту 9090 не отвечает (${status.status}). Запущен ли GoldHEN и PyLoader?`)
  return status
})
