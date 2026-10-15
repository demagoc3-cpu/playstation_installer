export type StorageKind = 'local' | 'smb' | 'nfs' | 'webdav';
export type StorageState =
  'unknown' | 'connecting' | 'online' | 'offline' | 'indexing' | 'disabled';
export interface StorageSource {
  id: string;
  kind: StorageKind;
  name: string;
  path: string;
  localPath: string;
  username: string;
  domain: string;
  hasPassword: boolean;
  enabled: boolean;
  autoIndex: boolean;
  indexIntervalMinutes: number;
  state: StorageState;
  message: string;
  packageCount: number;
  indexedBytes: number;
  lastIndexedAt?: number;
  lastCheckedAt?: number;
}
export interface StorageInput {
  id?: string;
  kind?: StorageKind;
  name?: string;
  path?: string;
  username?: string;
  domain?: string;
  password?: string;
  clearPassword?: boolean;
  enabled?: boolean;
  autoIndex?: boolean;
  indexIntervalMinutes?: number;
}
