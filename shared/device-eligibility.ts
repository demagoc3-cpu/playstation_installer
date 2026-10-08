import { contentForConsole, contentFormat, contentPlatform, type ContentIdentity } from './content-platform'
import type { ConsoleProfile } from './types/consoles'

/** Validate the entire selection. Compatibility is never inferred from filenames. */
export function deviceInstallReason(profile: ConsoleProfile, items: Array<ContentIdentity & { size: number; requiredFirmware?: string; sdkFirmware?: string }>, requiredBytes: number) {
  if (!items.length) return 'Нет файлов для установки'
  if (items.some(item => !contentForConsole(item, profile.platform))) return 'В наборе есть игры для другой платформы'
  if (!profile.online) return 'Нет связи с приставкой'
  if (profile.transport !== 'payload' && !profile.paired) return 'Требуется сопряжение'
  if (items.some(item => contentFormat(item) !== 'pkg')) return 'Установка этого формата ещё не подтверждена сервисом'
  if (profile.transport !== 'payload' && items.some(item => !profile.capabilities.formats.includes(contentFormat(item)) ||
    !(contentPlatform(item) === 'ps4' ? profile.capabilities.installPs4 : profile.capabilities.installPs5))) return 'Сервис ещё не поддерживает установку выбранных файлов'
  if (profile.platform === 'ps4' && profile.transport !== 'payload' && items.some(item => !['PS4GD','PS4GP','PS4AC','PS4AL','PS4GDE'].includes(item.contentType || ''))) return 'Тип пакета не поддерживается сервисом PS4'
  if (profile.platform === 'ps4' && profile.transport !== 'payload' && profile.capabilities.contentTypes && items.some(item => !profile.capabilities.contentTypes!.includes(item.contentType || ''))) return 'Обновите сервис PS4 для установки выбранного типа пакета'
  const version = (value?:string) => /^\d{1,2}\.\d{2}$/.test(value || '') ? Number(value) : undefined
  const firmware=version(profile.firmware)
  if (profile.platform === 'ps4' && firmware !== undefined && items.some(item => [version(item.requiredFirmware),version(item.sdkFirmware)].some(value=>value!==undefined && value>firmware))) return 'Пакет требует более новой прошивки PS4'
  if (profile.freeBytes !== undefined && profile.freeBytes < requiredBytes) return 'Недостаточно свободного места'
  return ''
}
