import { markPackageInstalled } from '../../../utils/package-library'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') || ''
  const body = await readBody<{ installed?: boolean }>(event)
  return markPackageInstalled(id, body?.installed !== false)
})
