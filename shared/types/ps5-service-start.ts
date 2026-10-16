export interface Ps5ServiceRelease {
  fileName: string;
  size: number;
  sha256: string;
  version: string;
  buildId: string;
  firmware: string;
}

export interface Ps5ServiceStartOperation {
  id: string;
  consoleId: string;
  state: 'checking' | 'starting' | 'verifying' | 'completed' | 'failed' | 'unconfirmed';
  method?: 'running' | 'pldmgr' | 'loader';
  version: string;
  buildId: string;
  message: string;
  startedAt: number;
}

export interface Ps5ServiceStartInfo {
  consoleId: string;
  state: 'running' | 'stopped' | 'unknown' | 'different-version';
  message: string;
  canStart: boolean;
  canInstall: boolean;
  managerAvailable: boolean;
  savedPayloadKnown: boolean;
  artifact?: Ps5ServiceRelease;
  operation?: Ps5ServiceStartOperation;
}
