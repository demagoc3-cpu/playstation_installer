import { serviceArtifact } from '../../../utils/service-updates'
export default defineEventHandler(event => {
  const a = serviceArtifact(String(getQuery(event).id || '')); const host = getHeader(event, 'host'); if (!host) throw createError({ statusCode: 400, message: 'Нет адреса WEB' })
  return { originalFileSize: a.size, packageDigest: a.packageDigest, numberOfSplitFiles: 1, pieces: [{ url: `http://${host}/api/ps4/service-update/file?id=${a.id}`, fileOffset: 0, fileSize: a.size, hashValue: '0000000000000000000000000000000000000000' }] }
})
