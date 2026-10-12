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
  folder?: { route: 'staged-folder'; ready: true; verificationWindow?: 2; streamProtocol?: 'folder-stream-v2'; storageCopies?: 1 }
  images?: { route: 'staged-image'; ready: true; protocol: 'image-registration-v1'; backend: 'ShadowMountPlus-1.7beta3'; registrationReceipt: true }
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
export interface InstallPackageSummary { packageId:string; title:string; titleId:string; type:string; version:string; size:number }
export interface DeviceInstallPreview {
  selection: { packageIds: string[] }
  files: number
  size: number
  packages: InstallPackageSummary[]
  devices: Array<{ profile: ConsoleProfile; eligible: boolean; reason: string; pending: number; requiredBytes: number; selectedBytes:number; queueBytes:number; reviewToken:string; queuedPackages:InstallPackageSummary[]; installedPackages: Array<InstallPackageSummary & { detail:string; canOverwrite:boolean; canReinstall:boolean; reinstallReason:string; affected:string[] }> }>
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
