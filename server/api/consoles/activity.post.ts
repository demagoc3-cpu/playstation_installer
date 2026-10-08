import { deviceActivities } from '../../utils/device-installation'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event,true)
  const ids = (await readBody(event))?.packageIds
  if (!Array.isArray(ids) || ids.length > 10000 || ids.some(id=>typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id))) throw createError({statusCode:400,message:'Неверный список файлов'})
  return deviceActivities(ids)
})
