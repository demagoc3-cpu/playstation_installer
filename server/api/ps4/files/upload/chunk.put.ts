import { assertInstallationOrigin } from '../../../../utils/installation-origin'
import { consoleFileWrite } from '../../../../utils/ps4-service-installer'

export default defineEventHandler(async event => {
  assertInstallationOrigin(event)
  if (getHeader(event, 'content-type') !== 'application/octet-stream') throw createError({ statusCode: 415, message: 'Ожидается фрагмент файла' })
  const query = getQuery(event)
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of event.node.req) {
    size += part.length
    if (size > 256 * 1024) throw createError({ statusCode: 413, message: 'Фрагмент файла слишком велик' })
    chunks.push(Buffer.from(part))
  }
  return consoleFileWrite(String(query.ip || ''), String(query.id || ''), Number(query.offset), Buffer.concat(chunks))
})
