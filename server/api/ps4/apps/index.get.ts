import { getConsoleCatalog } from '../../../utils/ps4-console-apps'
export default defineEventHandler(event => getConsoleCatalog(getQuery(event).ip))
