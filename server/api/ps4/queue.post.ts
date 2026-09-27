import { sendPackage } from '../../utils/ps4-installer'
import { readPackageIcon, resetPackageDelivery } from '../../utils/package-library'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ url?: string; title?: string; contentId?: string; contentType?: string; size?: number; packageId?: string }>(event)
  if (!body?.url || !/^https?:\/\//.test(body.url)) throw createError({ statusCode: 400, message: 'Для установки нужен доступный PS4 URL пакета' })
  if (!body.contentId || !body.contentType?.startsWith('PS4')) throw createError({ statusCode: 422, message: 'Не найдены метаданные PARAM.SFO. Добавьте корректный .pkg через выбор папки.' })
  if (body.packageId) resetPackageDelivery(body.packageId)
  const iconData = body.packageId ? await readPackageIcon(body.packageId).catch(() => undefined) : undefined
  await sendPackage({ url: body.url, title: body.title || 'PKG package', contentId: body.contentId, contentType: body.contentType, size: body.size || 0, iconData })
  return { queued: true }
})
