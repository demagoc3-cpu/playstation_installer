import { getServiceIcon } from '../../../utils/ps4-service-installer'
export default defineEventHandler(async event => {
  const q = getQuery(event)
  const data = await getServiceIcon(String(q.ip || ''), String(q.titleId || ''))
  setHeader(event, 'Content-Type', 'image/png')
  setHeader(event, 'Cache-Control', 'private, no-cache')
  return data
})
