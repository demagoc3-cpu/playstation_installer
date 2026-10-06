import { searchPackages, searchPackagePage } from '../../utils/search-providers'
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store')
  const query = getQuery(event), text = String(query.q || '')
  if (query.paged !== '1') return searchPackages(text)
  return searchPackagePage(text, Number(query.offset ?? 0), Number(query.limit ?? 50))
})
