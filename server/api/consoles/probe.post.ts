import { probeConsoleProfile, refreshConsoleProfile } from '../../utils/console-profiles'
import { assertInstallationOrigin } from '../../utils/installation-origin'
export default defineEventHandler(async event => {
  assertInstallationOrigin(event, true)
  const body = await readBody(event)
  if (body?.background !== undefined && typeof body.background !== 'boolean')
    throw createError({ statusCode: 400, message: 'Неверный режим проверки приставки' })
  return body?.background === true
    ? refreshConsoleProfile(body.id, true, true)
    : probeConsoleProfile(body?.id)
})
