import { inConsoleScope } from '../../utils/console-scope';
import { presetSelection } from '../../utils/presets';
import { getLocalIp } from '../../utils/ps4-installer';
import { ps4ServiceIp } from '../../utils/ps4-service';
import { getInstallationPreference } from '../../utils/installation-preference';
import {
  startInstallationQueue,
  appendInstallationQueue,
  getInstallationQueue,
} from '../../utils/installation-queue';
import { assertInstallationOrigin } from '../../utils/installation-origin';
import { getConsoleProfile, consoleProfileForIp } from '../../utils/console-profiles';
import { getPs5Queue, startPs5Queue } from '../../utils/ps5-installation-queue';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody<{
    id?: string;
    keys?: string[];
    ip?: string;
    transport?: string;
    consoleId?: string;
  }>(event);
  const profile = body?.consoleId
    ? getConsoleProfile(body.consoleId)
    : consoleProfileForIp(body?.ip || '');
  if (profile?.platform === 'ps5') {
    const ids = inConsoleScope(profile.ip, () => presetSelection(body.id, body.keys)).map(
        (item) => item.id,
      ),
      current = getPs5Queue(profile.id);
    return startPs5Queue({
      consoleId: profile.id,
      packageIds: ids,
      queueId: current.status === 'running' ? current.id : undefined,
    });
  }
  const ip = ps4ServiceIp(body?.ip);
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' });
  const ids = inConsoleScope(ip, () => presetSelection(body?.id, body?.keys)).map(
    (item) => item.id,
  );
  const pcIp = await getLocalIp(ip),
    port = getRequestURL(event).port || '3000';
  const input = {
    packageIds: ids,
    packageUrls: Object.fromEntries(
      ids.map((id) => [id, `http://${pcIp}:${port}/json/${id}.json`]),
    ),
  };
  const transport = body?.transport ?? getInstallationPreference(),
    current = getInstallationQueue(ip);
  if (current.status === 'running') {
    if (current.psIp !== body.ip || current.transport !== transport)
      throw createError({
        statusCode: 409,
        message: 'Работает другая очередь. Дождитесь её завершения.',
      });
    return appendInstallationQueue({ psIp: body.ip!, queueId: current.id!, ...input });
  }
  return startInstallationQueue({ psIp: body?.ip || '', ...input, transport });
});
