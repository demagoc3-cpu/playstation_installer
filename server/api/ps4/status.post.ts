import { getGoldHenStatus } from '../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string }>(event)
  return await getGoldHenStatus(body?.ip || '')
})
