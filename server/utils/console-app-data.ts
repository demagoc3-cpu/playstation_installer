import { consolePackageLabel } from './console-catalog.ts'
import type { LocalPackage } from './package-library'

/** Only catalog IDs are accepted; source URLs and filesystem paths stay on WEB. */
export function consoleSelection(packages: LocalPackage[], gameId: string, action: string, ids: string[] = []) {
  const group = packages.filter(p => (p.titleId || p.id) === gameId)
    .sort((a, b) => a.installOrder - b.installOrder || a.fileName.localeCompare(b.fileName))
  if (!group.length) throw new Error('Игра больше не находится в библиотеке WEB')
  if (action === 'reinstall-preview' || action === 'reinstall') {
    const base = group.find(p => p.contentType === 'PS4GD')
    if (!base) throw new Error('Для переустановки нужен базовый PKG игры')
    return action === 'reinstall-preview' ? [base] : group
  }
  if (action === 'all') return group
  if (action === 'dlc') return group.filter(p => p.type === 'DLC')
  if (action === 'patches') return group.filter(p => p.type === 'Патч' || p.type === 'Бэкпорт')
  if (action !== 'selected' || !ids.length || ids.length > 128 || ids.some(id => !group.some(p => p.id === id)))
    throw new Error('Выберите пакеты из этой карточки игры')
  return group.filter(p => ids.includes(p.id))
}

export function consoleQueueTasks(queue: { psIp?: string; items: Array<{ packageId: string; state: string; detail: string; bytesSent: number }> }, ip: string, packages: LocalPackage[], language: 'ru' | 'en' = 'ru') {
  if (queue.psIp !== ip) return []
  return queue.items.slice(0, 256).map(item => {
    const pkg = packages.find(p => p.id === item.packageId)
    return {
      id: item.packageId, title: pkg ? `${pkg.title || pkg.titleId} • ${consolePackageLabel(pkg, language)}` : item.packageId,
      kind: ({ 'Игра': 'game', 'Патч': 'patch', 'Бэкпорт': 'backport', DLC: 'dlc' } as const)[pkg?.type || 'Игра'],
      state: item.state, detail: item.detail,
      // Full transfer is not proof of a successful installation.
      progress: item.state === 'installed' ? 100 : pkg?.size ? Math.max(0, Math.min(99, Math.floor(item.bytesSent / pkg.size * 100))) : 0,
    }
  })
}
