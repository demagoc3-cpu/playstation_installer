import { getSearchDetails } from '../../../utils/search-source'

export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  return getSearchDetails(getRouterParam(event, 'id') || '')
})
