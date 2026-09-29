import { consoleRuntime } from '../../../utils/console-control'
export default defineEventHandler(event => { const q = getQuery(event); return consoleRuntime(q.ip, q.titleId) })
