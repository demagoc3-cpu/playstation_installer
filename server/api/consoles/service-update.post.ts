import { getConsoleProfile } from '../../utils/console-profiles'
import { beginPs5ServiceUpdate } from '../../utils/ps5-service-updates'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const profile = getConsoleProfile((await readBody(event))?.consoleId)
  if (profile.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Для PS4 выберите PKG обновления в карточке устройства' })
  return beginPs5ServiceUpdate(profile.id)
})
