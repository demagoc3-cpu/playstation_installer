import { getPackage, isDeliveryBlocked, recordPackageRequest } from '../../utils/package-library'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  const item = getPackage(id)
  if (isDeliveryBlocked(id)) throw createError({ statusCode: 410, statusMessage: 'Installation cancelled' })
  recordPackageRequest(id)
  console.log(`[PackageFlow] PS4 запросила манифест «${item.title}» (${item.fileName})`)
  const host = getHeader(event, 'host')
  if (!host) throw createError({ statusCode: 400, statusMessage: 'Не удалось определить адрес сервера пакетов' })
  setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-store')
  return {
    originalFileSize: item.size,
    packageDigest: item.packageDigest,
    numberOfSplitFiles: 1,
    pieces: [{
      url: `http://${host}/api/packages/${item.id}`,
      fileOffset: 0,
      fileSize: item.size,
      hashValue: '0000000000000000000000000000000000000000',
    }],
  }
})
