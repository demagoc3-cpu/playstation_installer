import { startInstaller } from '../../utils/ps4-installer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ ip?: string }>(event)
  return await startInstaller(body?.ip || '')
})
