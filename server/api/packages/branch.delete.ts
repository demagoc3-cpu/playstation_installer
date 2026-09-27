import { removePackageBranch } from '../../utils/package-library'

export default defineEventHandler((event) => {
  const titleId = getQuery(event).titleId?.toString() || ''
  if (!titleId) throw createError({ statusCode: 400, message: 'Не указан CUSA игры' })
  return removePackageBranch(titleId)
})
