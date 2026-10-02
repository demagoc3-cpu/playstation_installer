interface AutomaticPackage {
  id: string
  titleId: string
  title: string
  fileName: string
  contentType: string
  contentId?: string
  appVersion?: string
  installOrder: number
  installedAt?: number
}

export interface ConsoleInstallSnapshot {
  baseTitleIds: Set<string>
  patchTitleIds: Set<string>
  dlcContentIds: Set<string>
}

function comparePackages(a: AutomaticPackage, b: AutomaticPackage) {
  return a.installOrder - b.installOrder || a.title.localeCompare(b.title) ||
    (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) ||
    a.fileName.localeCompare(b.fileName, undefined, { numeric: true })
}

function comparePatchVersion(a: AutomaticPackage, b: AutomaticPackage) {
  return (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) ||
    a.fileName.localeCompare(b.fileName, undefined, { numeric: true })
}

/** Keep the known patch chain in order, continuing after the last installed variant. */
export function selectAutomaticPackages<T extends AutomaticPackage>(items: T[], library: AutomaticPackage[] = items, console?: ConsoleInstallSnapshot): T[] {
  const sorted = [...items].sort(comparePackages)
  const installed = (item: AutomaticPackage) => {
    if (!console) return Boolean(item.installedAt)
    if (item.contentType === 'PS4GD') return console.baseTitleIds.has(item.titleId)
    if (item.contentType === 'PS4AC') return console.dlcContentIds.has(item.contentId || '')
    // PS4AL has no ac.pkg for the console inventory to list. Remember its
    // successful BGFT completion while the base game remains installed.
    if (item.contentType === 'PS4AL') return console.dlcContentIds.has(item.contentId || '') ||
      console.baseTitleIds.has(item.titleId) && Boolean(item.installedAt)
    if (item.contentType === 'PS4GP' && !console.patchTitleIds.has(item.titleId)) return false
    return Boolean(item.installedAt)
  }
  const lastInstalledPatch = new Map<string, AutomaticPackage>()
  for (const item of library) {
    if (item.contentType !== 'PS4GP' || !installed(item)) continue
    const previous = lastInstalledPatch.get(item.titleId)
    if (!previous || comparePatchVersion(item, previous) > 0) lastInstalledPatch.set(item.titleId, item)
  }
  return sorted.filter((item) => !installed(item) &&
    (item.contentType !== 'PS4GP' || !lastInstalledPatch.has(item.titleId) || comparePatchVersion(item, lastInstalledPatch.get(item.titleId)!) > 0))
}
