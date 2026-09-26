import { searchPackages } from '../../utils/search-providers'
export default defineEventHandler((event) => searchPackages(String(getQuery(event).q || '')))
