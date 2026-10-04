import { consoleFileRequest, serviceKeyConfigured } from '../../../utils/ps4-service-installer'
import { ps4ServiceIp } from '../../../utils/ps4-service'

// A public catalog is not proof of pairing. Verify the saved bearer against
// the console; neither the key nor pairing code is returned to the frontend.
export default defineEventHandler(async event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const ip = ps4ServiceIp(getQuery(event).ip)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  if (!serviceKeyConfigured(ip)) return { paired: 0, online: 1 }
  try {
    await consoleFileRequest(ip, 'capabilities', {})
    return { paired: 1, online: 1 }
  } catch (cause: any) {
    if ([401, 403, 409].includes(cause?.statusCode)) return { paired: 0, online: 1 }
    return { paired: 0, online: 0 }
  }
})
