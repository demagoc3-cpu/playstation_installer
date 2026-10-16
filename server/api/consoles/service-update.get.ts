import { getConsoleProfile } from '../../utils/console-profiles';
import { ps5ServiceUpdateInfo } from '../../utils/ps5-service-updates';
import { getMaintenance } from '../../utils/console-maintenance';
export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  const profile = getConsoleProfile(getQuery(event).consoleId);
  return profile.platform === 'ps5'
    ? ps5ServiceUpdateInfo(profile.id)
    : {
        consoleId: profile.id,
        current: profile.pkgVersion || '',
        flow: await getMaintenance(profile.ip),
      };
});
