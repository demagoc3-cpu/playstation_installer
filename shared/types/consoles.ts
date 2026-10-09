export type ConsolePlatform = 'ps4' | 'ps5'
export type ContentPlatform = ConsolePlatform | 'unknown'
export type ContentFormat = 'pkg' | 'folder' | 'ufs2' | 'exfat' | 'pfs' | 'ffpfsc' | 'unknown'
export type PackageSignature = 'retail' | 'fake' | 'unknown'

export interface ConsoleCapabilities {
  formats: ContentFormat[]
  installPs4: boolean
  installPs5: boolean
  background: boolean
  contentTypes?: string[]
  folder?: { route: 'staged-folder'; ready: true }
  installation?: { route: 'staged-pkg'; ready: boolean; reason: string; exactVersionReceipt: false }
}

export interface ConsoleProfile {
  id: string
  name: string
  ip: string
  platform: ConsolePlatform
  verified: boolean
  version?: string
  pkgVersion?: string
  firmware?: string
  model?: string
  transport?: 'service' | 'payload'
  freeBytes?: number
  checkedAt?: number
  paired: boolean
  online: boolean
  capabilities: ConsoleCapabilities
}

export interface DeviceSelection {
  packageIds?: string[]
  librarySelection?: { scope: 'all' | 'dlc'; titleId?: string; platform?: 'all' | 'ps4' | 'ps5' }
  preset?: { id: string; keys?: string[] }
}
export interface DeviceInstallPreview {
  selection: { packageIds: string[] }
  files: number
  size: number
  devices: Array<{ profile: ConsoleProfile; eligible: boolean; reason: string; pending: number; requiredBytes: number }>
}
export interface DeviceActivity {
  consoleId: string; status: string; queueId?: string; message?: string
  counts: { active: number; queued: number; completed: number; failed: number }
  activePackageIds: string[]; queuedPackageIds: string[]; installedPackageIds: string[]
}

export interface ConsoleProfiles {
  activeId: string | null
  consoles: ConsoleProfile[]
}
