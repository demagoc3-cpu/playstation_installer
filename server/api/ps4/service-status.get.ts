export default defineEventHandler(async (event) => {
  const ip = String(getQuery(event).ip || '')
  const parts = ip.split('.').map(Number)
  const local = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || (parts[0] === 169 && parts[1] === 254))
  if (!local) throw createError({ statusCode: 400, message: 'Укажите локальный IPv4-адрес PS4' })

  try {
    const response = await fetch(`http://${ip}:12801/ping`, { signal: AbortSignal.timeout(3000) })
    const body = await response.json() as { service?: string; status?: string; version?: string }
    if (response.ok && body.service === 'PackegeFlowService' && body.status === 'ok') {
      return { ready: true, ip, version: body.version || 'неизвестна' }
    }
    return { ready: false, ip, reason: 'Сервис ответил неожиданными данными' }
  } catch {
    return { ready: false, ip, reason: 'Сервис не отвечает на порту 12801' }
  }
})
