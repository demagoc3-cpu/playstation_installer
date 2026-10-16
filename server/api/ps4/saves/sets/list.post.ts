import { assertInstallationOrigin } from '../../../../utils/installation-origin';
import { ps4ManagementIp } from '../../../../utils/console-management-target';
import { listSaveSets } from '../../../../utils/save-set-store';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  const ip = body?.ip === undefined ? undefined : ps4ManagementIp(body.ip);
  return { sets: listSaveSets().filter((set) => !ip || set.sourceIp === ip) };
});
