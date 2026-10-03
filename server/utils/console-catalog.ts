import type { LocalPackage } from './package-library'

/** Compact display label; the exact source filename remains available separately. */
export function consolePackageLabel(item: LocalPackage, language: 'ru' | 'en' = 'ru') {
  const labels = language === 'en' ? { 'Игра': 'Game', 'Патч': 'Patch', 'Бэкпорт': 'Backport', DLC: 'DLC' }
    : { 'Игра': 'Игра', 'Патч': 'Патч', 'Бэкпорт': 'Бэкпорт', DLC: 'DLC' }
  if (item.type === 'DLC') return item.title || item.fileName.replace(/\.pkg$/i, '')
  const variant = /(?:^|[_ .\[\]()-])(?:RUS|RUSSIAN|РУС|РУСИФ(?:ИКАЦИЯ)?)(?:[_ .\[\]()-]|$)/i.test(item.fileName) ? (language === 'en' ? ' • Russian' : ' • Русификация') : ''
  return `${labels[item.type] || item.type}${item.appVersion ? ` ${item.appVersion}` : ''}${variant}`
}

export function buildConsoleCatalog(packages: LocalPackage[], language: 'ru' | 'en' = 'ru') {
  const groups = new Map<string, LocalPackage[]>()
  for (const pkg of packages) {
    const key = pkg.titleId || pkg.id
    groups.set(key, [...(groups.get(key) || []), pkg])
  }
  return {
    schemaVersion: 1,
    mode: 'web-library',
    capabilities: { download: false, install: true, localTorrent: false },
    games: [...groups.entries()].slice(0, 24).map(([id, items]) => {
      items.sort((a, b) => a.installOrder - b.installOrder || a.fileName.localeCompare(b.fileName))
      const base = items.find(item => item.type === 'Игра') || items[0]!
      const cover = items.find(item => item.iconSize > 0)
      return {
        id,
        title: base.title,
        titleId: base.titleId,
        description: language === 'ru'
          ? 'Пакеты из вашей библиотеки WEB. Выберите игру, патчи, бэкпорты и DLC. PackageFlowService установит выбранные PKG напрямую с WEB. Состояние очереди общее для приложения и WEB.'
          : 'Packages from your WEB library. Choose the game, patches, backports and DLC. PackageFlowService installs the selected PKGs directly from WEB. The app and WEB share one installation queue.',
        cover: cover ? `/api/packages/${cover.id}?asset=icon` : '',
        packageCount: items.length,
        patchCount: items.filter(p => p.type === 'Патч' || p.type === 'Бэкпорт').length,
        dlcCount: items.filter(p => p.type === 'DLC').length,
        packages: items.slice(0, 128).map(item => ({
          id: item.id,
          title: consolePackageLabel(item, language),
          fileName: item.fileName,
          kind: ({ 'Игра': 'game', 'Патч': 'patch', 'Бэкпорт': 'backport', DLC: 'dlc' } as const)[item.type],
          version: item.appVersion || '',
          firmware: item.requiredFirmware || '',
          size: item.size,
          installed: Boolean(item.installedAt),
          magnet: null,
        })),
      }
    }),
  }
}
