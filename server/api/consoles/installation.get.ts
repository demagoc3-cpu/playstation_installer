import { getConsoleProfile } from '../../utils/console-profiles';
import { getPs5Queue } from '../../utils/ps5-installation-queue';
import { getInstallationQueue } from '../../utils/installation-queue';
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  const p = getConsoleProfile(getQuery(event).consoleId);
  return p.platform === 'ps5' ? getPs5Queue(p.id) : getInstallationQueue(p.ip);
});
