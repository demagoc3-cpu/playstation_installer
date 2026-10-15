import { getConsoleProfile } from '../../utils/console-profiles';
import { getPs5Tasks } from '../../utils/ps5-installation-queue';
import { getInstallationTasks } from '../../utils/installation-tasks';
import { inConsoleScope } from '../../utils/console-scope';
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  const q = getQuery(event),
    p = getConsoleProfile(q.consoleId);
  return p.platform === 'ps5'
    ? getPs5Tasks(p.id, q)
    : inConsoleScope(p.ip, () => getInstallationTasks({ ...q, ip: p.ip }));
});
