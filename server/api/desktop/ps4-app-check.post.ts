import { assertDesktopControl } from '../../utils/desktop-control';
import { assertDesktopWritable } from '../../utils/desktop-lifecycle';
import { assertInstallationOrigin } from '../../utils/installation-origin';
import { getConsoleProfile } from '../../utils/console-profiles';
import { getConsoleCatalog } from '../../utils/ps4-console-apps';
import {
  serviceArtifact,
  comparePkgVersions,
  installServiceArtifact,
} from '../../utils/service-updates';
import { readPs4Service } from '../../utils/ps4-service';
import { getLocalIp } from '../../utils/ps4-installer';
import { getMaintenance } from '../../utils/console-maintenance';

export default defineEventHandler(async (event) => {
  assertDesktopControl(event);
  assertInstallationOrigin(event, true);
  assertDesktopWritable();
  const body = await readBody(event),
    p = getConsoleProfile(body?.consoleId);
  if (p.platform !== 'ps4') throw createError({ statusCode: 400, message: 'Выберите PS4' });
  const artifact = serviceArtifact(String(body?.artifactId || ''));
  const catalog = await getConsoleCatalog(p.ip);
  if (!catalog.complete)
    throw createError({
      statusCode: 409,
      message: 'Список приложений PS4 не прочитан полностью; установка не отправлена',
    });
  if (catalog.apps.some((app) => app.titleId === 'PFLS00001')) return { installed: true };
  if (body?.observeOnly === true) return { installed: false };
  const current = await readPs4Service(p.ip, '/system/info'),
    info = current.body as any;
  if (
    current.status !== 200 ||
    info?.service !== 'PackegeFlowService' ||
    comparePkgVersions(info.pkgVersion, artifact.version) !== 0
  )
    throw createError({
      statusCode: 409,
      message: 'Для восстановления приложения требуется комплект работающей версии службы',
    });
  const old = await getMaintenance(p.ip);
  if (old && old.kind === 'update' && !['completed', 'failed'].includes(old.state))
    return { installed: false, flow: old };
  const pc = await getLocalIp(p.ip),
    port = getRequestURL(event).port || '3000';
  return {
    installed: false,
    flow: await installServiceArtifact(p.ip, artifact.id, `http://${pc}:${port}`, true),
  };
});
