import type { ConsolePlatform, ContentPlatform, ContentFormat } from './types/consoles.ts'

export interface ContentIdentity {
  platform?: ContentPlatform
  format?: ContentFormat
  contentType?: string
  titleId?: string
  contentId?: string
}

/** Legacy entries were read from CNT/SFO. Never infer a platform from a filename. */
export function contentPlatform(item: ContentIdentity): ContentPlatform {
  if (item.platform === 'ps4' || item.platform === 'ps5') return item.platform
  if (item.platform === 'unknown') return 'unknown'
  if (/^PS4/.test(item.contentType || '')) return 'ps4'
  if (/^PS5/.test(item.contentType || '')) return 'ps5'
  return 'unknown'
}

export function contentFormat(item: ContentIdentity): ContentFormat {
  if (item.format) return item.format
  return /^PS[45]/.test(item.contentType || '') ? 'pkg' : 'unknown'
}

/** A PS5 can target PS4 content; a PS4 never targets PS5 content. Installation
 * additionally requires the selected service's verified backend capabilities. */
export function contentForConsole(item: ContentIdentity, target: ConsolePlatform) {
  const platform = contentPlatform(item)
  return platform === target || (target === 'ps5' && platform === 'ps4')
}

export function contentBranchKey(item: ContentIdentity & { id?: string }) {
  return `${contentPlatform(item)}:${item.titleId || item.id || ''}`
}

export function filterContent<T extends ContentIdentity>(items: T[], platform: unknown, target?: unknown): T[] {
  return items.filter(item =>
    (platform !== 'ps4' && platform !== 'ps5' && platform !== 'unknown' || contentPlatform(item) === platform) &&
    (target !== 'ps4' && target !== 'ps5' || contentForConsole(item, target)))
}
