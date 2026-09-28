import { getPs4SystemSnapshot, localPs4Ip } from '../../utils/ps4-service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const ip = localPs4Ip(getQuery(event).ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите локальный IPv4-адрес PS4' })
  return getPs4SystemSnapshot(ip)
})
