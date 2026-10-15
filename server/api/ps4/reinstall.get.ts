import { reinstallPlan } from '../../utils/console-maintenance';
import { getLocalIp } from '../../utils/ps4-installer';
export default defineEventHandler(async (event) => {
  const q = getQuery(event),
    plan = await reinstallPlan(q.ip, q.packageId);
  const pcIp = await getLocalIp(String(q.ip)),
    port = (getHeader(event, 'host') || '').match(/:(\d+)$/)?.[1] || '3000';
  return { ...plan, url: `http://${pcIp}:${port}/json/${plan.packageId}.json` };
});
