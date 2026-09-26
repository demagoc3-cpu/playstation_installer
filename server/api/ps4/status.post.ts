import { getGoldHenStatus, savePsIp } from '../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string }>(event)
  const ip = body?.ip?.trim() || ''
  const status = await getGoldHenStatus(ip)
  // Remember the address the user connected to, even if the console is asleep right now.
  savePsIp(ip)
  return status
})
