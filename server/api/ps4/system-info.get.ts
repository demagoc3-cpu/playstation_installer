import { getPs4SystemSnapshot, ps4ServiceIp } from '../../utils/ps4-service'

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const ip = ps4ServiceIp(getQuery(event).ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IPv4-адрес PS4' })
  return getPs4SystemSnapshot(ip)
})
