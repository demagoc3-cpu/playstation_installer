import type { ConsoleCapabilities, ContentFormat } from './types/consoles'
export interface Ps5SpaceItem { size: number; format: ContentFormat; legacyFolder?: boolean }
/** Never reduce space for an old ELF, a legacy plan, PKG or disk image.
 * Offset credit requires a live device receipt; saved WEB progress is not
 * subtracted here. Reserve covers filesystem/manifest/journal overhead. */
export function requiredPs5InstallSpace(items: Ps5SpaceItem[], capabilities: ConsoleCapabilities) {
  let bytes = 0, streamingBytes = 0
  for (const item of items) {
    if (item.format === 'folder' && !item.legacyFolder && capabilities.folder?.streamProtocol === 'folder-stream-v2' && capabilities.folder.storageCopies === 1) { bytes += item.size; streamingBytes += item.size }
    else bytes += item.size * 2
  }
  return bytes + (streamingBytes ? Math.max(512 * 1024 * 1024, Math.ceil(streamingBytes * 0.02)) : 0)
}
