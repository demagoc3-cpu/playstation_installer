import { lstatSync, readFileSync } from 'node:fs';
import { dataPath } from './data-path';
import type { ConsoleCapabilities, ContentFormat } from '../../shared/types/consoles';

const formats = ['folder', 'ufs2', 'exfat', 'pfs', 'ffpfsc'] as const;
export interface Ps5QualifiedRoutes {
  userEnabledFormats: Array<(typeof formats)[number]>;
}

/** Explicit local activation of previously tested routes, not a live mount
 * report. The publisher still owns hashing, publication and registration. */
export function readPs5QualifiedRoutes(
  consoleId: string,
  ip: string,
): Ps5QualifiedRoutes | undefined {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(consoleId)) return;
  try {
    const path = dataPath('consoles', consoleId, 'ps5-qualified-routes.json');
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return;
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (
      saved?.schemaVersion !== 1 ||
      saved.consoleId !== consoleId ||
      saved.ip !== ip ||
      saved.firmware !== '13.60' ||
      saved.serviceBuild !== 'ps5-service-pkg-context-029c-sse2' ||
      saved.serviceVersion !== '0.1.29-dev' ||
      saved.folderProtocol !== 'folder-stream-v2' ||
      saved.imageProtocol !== 'image-registration-v1' ||
      saved.imageBackend !== 'ShadowMountPlus-1.7beta3' ||
      !/^[0-9a-f]{32}$/.test(saved.qualification?.folderReceiptId || '') ||
      !/^[0-9a-f]{32}$/.test(saved.qualification?.streamReceiptId || '') ||
      !/^[0-9a-f]{64}$/.test(saved.qualification?.imageMarkerSha256 || '') ||
      !Array.isArray(saved.userEnabledFormats) ||
      saved.userEnabledFormats.length !== formats.length ||
      new Set(saved.userEnabledFormats).size !== saved.userEnabledFormats.length ||
      saved.userEnabledFormats.some((value: unknown) => !formats.includes(value as any))
    )
      return;
    return { userEnabledFormats: saved.userEnabledFormats };
  } catch {
    return;
  }
}

export function withPs5QualifiedRoutes(
  capabilities: ConsoleCapabilities,
  activation: Ps5QualifiedRoutes,
): ConsoleCapabilities {
  const enabled = activation.userEnabledFormats;
  return {
    ...capabilities,
    formats: [...new Set<ContentFormat>([...capabilities.formats, ...enabled])],
    installPs5: true,
    ...(enabled.includes('folder')
      ? {
          folder: {
            route: 'staged-folder' as const,
            ready: true as const,
            verificationWindow: 2 as const,
            streamProtocol: 'folder-stream-v2' as const,
            storageCopies: 1 as const,
          },
        }
      : {}),
    ...(enabled.some((format) => format !== 'folder')
      ? {
          images: {
            route: 'staged-image' as const,
            ready: true as const,
            protocol: 'image-registration-v1' as const,
            backend: 'ShadowMountPlus-1.7beta3' as const,
            registrationReceipt: true as const,
          },
        }
      : {}),
  };
}
