import { AsyncLocalStorage } from 'node:async_hooks';
import { dataPath } from './data-path';
import { readJsonFile, writeJsonFile } from './json-store';

const scope = new AsyncLocalStorage<{ ip?: string }>();
export function legacyConsoleIp(): string | undefined {
  return (
    readJsonFile<{ ip?: string }>(dataPath('legacy-console.json'), {}).ip ||
    readJsonFile<{ ip?: string }>(dataPath('ps4.json'), {}).ip ||
    readJsonFile<{ psIp?: string }>(dataPath('installation-queue.json'), {}).psIp
  );
}
/** Freeze the owner of old global state before connecting another profile. */
export function captureLegacyConsole() {
  const ip = legacyConsoleIp();
  if (ip && !readJsonFile<{ ip?: string }>(dataPath('legacy-console.json'), {}).ip)
    writeJsonFile(dataPath('legacy-console.json'), { version: 1, ip });
}
function activeIp() {
  const saved = readJsonFile<{ activeId?: string; consoles?: Array<{ id: string; ip: string }> }>(
    dataPath('console-profiles.json'),
    {},
  );
  return saved.consoles?.find((item) => item.id === saved.activeId)?.ip || legacyConsoleIp();
}
export const currentConsoleIp = () => scope.getStore()?.ip;
export function inConsoleScope<T>(ip: string | undefined, action: () => T): T {
  const target = ip || scope.getStore()?.ip || activeIp();
  if (
    target &&
    (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(target) ||
      target.split('.').some((part) => Number(part) > 255))
  )
    throw new Error('Invalid console scope');
  return scope.run({ ip: target }, action);
}
export function consoleDataPath(file: string) {
  const ip = currentConsoleIp();
  return ip ? dataPath('consoles', ip, file) : dataPath(file);
}
export function consoleDeliveryKey(id: string) {
  const ip = currentConsoleIp();
  return ip ? `${ip}:${id}` : id;
}

export function currentConsolePlatform(): 'ps4' | 'ps5' | undefined {
  const ip = currentConsoleIp();
  if (!ip) return undefined;
  const saved = readJsonFile<{ consoles?: Array<{ ip: string; platform: 'ps4' | 'ps5' }> }>(
    dataPath('console-profiles.json'),
    {},
  );
  return saved.consoles?.find((item) => item.ip === ip)?.platform || 'ps4';
}
