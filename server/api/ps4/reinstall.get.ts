import { reinstallPlan } from '../../utils/console-maintenance'
export default defineEventHandler(event => { const q = getQuery(event); return reinstallPlan(q.ip, q.packageId) })
