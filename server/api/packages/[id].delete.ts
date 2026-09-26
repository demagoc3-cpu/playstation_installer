import { removePackageFromLibrary } from '../../utils/package-library'

export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id') || ''
  removePackageFromLibrary(id)
  setResponseStatus(event, 204)
  return null
})
