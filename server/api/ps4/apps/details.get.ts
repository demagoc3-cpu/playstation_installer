import { getConsoleDetails } from '../../../utils/ps4-console-apps'
export default defineEventHandler(event => { const q = getQuery(event); return getConsoleDetails(q.ip, q.titleId) })
