import { existsSync, readdirSync } from 'node:fs';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { readJsonFile } from './json-store';
import { localInstallActive, readFileInstallations } from './console-file-install-store';
import { readMaintenance } from './maintenance-store';
import { consoleSpeedLocked } from './console-speed-lock';
import type { InstallationTransport } from '../../shared/types/installation';

export const PS4_PARALLEL_SERVICE_REQUIRED =
  'Для параллельной установки используйте PackageFlowService. PyLoader обслуживает одну приставку';

/** Enforce the shared PyLoader session rule even outside the device dialog. */
export function ps4TransportConflict(ip: string, transport: InstallationTransport): string {
  const profiles = readJsonFile<{ consoles?: Array<{ id: string; ip: string }> }>(
    dataPath('console-profiles.json'),
    {},
  );
  const id = profiles.consoles?.find((profile) => profile.ip === ip)?.id;
  if (id && consoleSpeedLocked(id))
    return 'Идёт тест скорости выбранной приставки. Дождитесь результата или остановите тест.';
  if (
    transport === 'payload' &&
    (readFileInstallations().some((job) => job.ip !== ip && localInstallActive(job)) ||
      Object.entries(readMaintenance()).some(
        ([other, flow]) => other !== ip && !['completed', 'failed'].includes(flow.state),
      ))
  )
    return PS4_PARALLEL_SERVICE_REQUIRED;
  const root = dataPath('consoles');
  const ips = new Set(
    existsSync(root)
      ? readdirSync(root, { withFileTypes: true })
          .filter((item) => item.isDirectory() && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(item.name))
          .map((item) => item.name)
      : [],
  );
  type Queue = { version?: number; psIp?: string; status?: string; transport?: string };
  const legacy = readJsonFile<Queue>(dataPath('installation-queue.json'), {});
  if (legacy.psIp) ips.add(legacy.psIp);
  for (const other of ips) {
    if (other === ip) continue;
    const path = dataPath('consoles', other, 'installation-queue.json');
    const queue = existsSync(path)
      ? readJsonFile<Queue>(path, {})
      : legacy.psIp === other
        ? legacy
        : {};
    if (
      queue.version !== 1 ||
      queue.psIp !== other ||
      !['running', 'cancelling'].includes(queue.status || '')
    )
      continue;
    // Legacy queues without a transport use PyLoader.
    if (transport === 'payload' || queue.transport !== 'service')
      return PS4_PARALLEL_SERVICE_REQUIRED;
  }
  return '';
}

export function assertPs4TransportAdmission(ip: string, transport: InstallationTransport) {
  const reason = ps4TransportConflict(ip, transport);
  if (reason) throw createError({ statusCode: 409, message: reason });
}
