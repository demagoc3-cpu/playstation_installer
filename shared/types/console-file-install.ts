import type { ServiceInstallJob } from './installation'
export interface ConsolePackagePreview {
  path: string; revision: string; size: number; title: string; titleId: string; contentId: string; contentType: string
  type: string; appVersion: string; requiredFirmware?: string; sdkFirmware?: string
  compatible: boolean; firmwareMessage: string; spaceMessage: string; canInstall: boolean
}
export interface ConsolePackageInstallation {
  id: string; ip: string; path: string; title: string; createdAt: string; pending: boolean; rejected?: boolean
  job?: ServiceInstallJob; error?: string
}
