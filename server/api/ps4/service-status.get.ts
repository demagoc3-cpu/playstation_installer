import { localPs4Ip, readPs4Service } from '../../utils/ps4-service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const ip = localPs4Ip(getQuery(event).ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите локальный IPv4-адрес PS4' })

  try {
    const response = await readPs4Service(ip, '/ping')
    const body = response.body as { service?: string; status?: string; version?: string } | null
    if (response.status === 200 && body?.service === 'PackegeFlowService' && body.status === 'ok') {
      return { ready: true, ip, version: body.version || 'неизвестна' }
    }
    return { ready: false, ip, reason: 'Сервис ответил неожиданными данными' }
  } catch {
    return { ready: false, ip, reason: 'Сервис не отвечает на порту 12801' }
  }
})
