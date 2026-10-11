import { contentFormat, contentPlatform } from './content-platform.ts'
import type { ContentFormat, ContentPlatform, PackageSignature } from './types/consoles'

export interface GameDetailsSource {
  id: string; title: string; titleId: string; fileName: string; type: string; size: number
  installOrder?: number; platform?: ContentPlatform; format?: ContentFormat; signature?: PackageSignature
  contentId?: string; appVersion?: string; masterVersion?: string; requiredFirmware?: string
  sdkFirmware?: string; contentType?: string
}

/** An explicit allowlist shared by WEB previews and the PS5 catalog. These are
 * source metadata, not a compatibility verdict or a system installation receipt. */
export function gameDetails(items: readonly GameDetailsSource[]) {
  const ordered = [...items].sort((a, b) => (a.installOrder || 0) - (b.installOrder || 0)
    || a.fileName.localeCompare(b.fileName) || a.id.localeCompare(b.id))
  const base = ordered.find(item => item.type === 'Игра'), source = base || ordered[0]
  if (!source) return undefined
  return {
    packageId: source.id, hasBase: Boolean(base), titleId: source.titleId,
    contentId: source.contentId || '', fileName: source.fileName,
    platform: contentPlatform(source), format: contentFormat(source), signature: source.signature || 'unknown',
    version: source.appVersion || '', masterVersion: source.masterVersion || '',
    firmware: source.requiredFirmware || '', sdk: source.sdkFirmware || '', category: source.contentType || '',
    size: source.size,
  }
}
