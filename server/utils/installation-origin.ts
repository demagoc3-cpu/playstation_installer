import type { H3Event } from 'h3'
import { createError, getHeader, getRequestURL } from 'h3'
export function assertInstallationOrigin(event: H3Event, requireJson = false) {
  const origin = getHeader(event, 'origin')
  if (origin && origin !== getRequestURL(event).origin) throw createError({ statusCode: 403, message: 'Откройте PackageFlow напрямую, чтобы отправить задание' })
  if (requireJson && !/^application\/json(?:\s*;|$)/i.test(getHeader(event, 'content-type') || ''))
    throw createError({ statusCode: 415, message: 'Ожидается JSON-запрос' })
}
