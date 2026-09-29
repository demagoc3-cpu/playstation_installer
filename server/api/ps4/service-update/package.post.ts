import { stageServicePackage, updateLimit } from '../../../utils/service-updates'
import { assertInstallationOrigin } from '../../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event)
  if (!/^application\/octet-stream(?:;|$)/.test(getHeader(event, 'content-type') || '')) throw createError({ statusCode: 415, message: 'Ожидается файл PKG' })
  const chunks: Buffer[] = []; let count = 0
  for await (const chunk of event.node.req) { count += chunk.length; if (count > updateLimit) throw createError({ statusCode: 413, message: 'Максимальный размер — 25 МБ' }); chunks.push(Buffer.from(chunk)) }
  return stageServicePackage(Buffer.concat(chunks))
})
