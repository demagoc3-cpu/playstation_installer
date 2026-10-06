export interface LibraryEntry {
  id: string
  title: string
  fileName: string
  titleId: string
  contentId: string
  type: string
  size: number
  installOrder: number
  iconSize?: number
  appVersion?: string
  installedAt?: number
}
export interface LibrarySummary {
  packages: number
  games: number
  size: number
  installed: number
  delivered: number
  ready: number
  readyDlc: number
}
export interface LibraryPage<T> {
  packages: Array<T & { groupTitle: string; groupIconId?: string; groupPackages: number; groupReadyDlc: number }>
  page: number
  pageSize: number
  pages: number
  total: number
  unit: 'packages' | 'games'
  summary: LibrarySummary
}
export interface LibraryQuery { page?: unknown; pageSize?: unknown; q?: unknown; unit?: unknown }

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/ё/g, 'е')
export function librarySearchTokens(value: unknown) {
  return normalize(typeof value === 'string' ? value.trim().slice(0, 256) : '').split(/\s+/).filter(Boolean)
}
export function matchesLibrarySearch(item: LibraryEntry, tokens: string[]) {
  const text = normalize([item.title, item.fileName, item.titleId, item.contentId, item.type, item.appVersion].join(' '))
  return tokens.every(token => text.includes(token))
}

/** Filter the complete index before slicing; only this slice is sent to WEB. */
export function paginateLibrary<T extends LibraryEntry>(items: T[], query: LibraryQuery = {}, deliveredIds = new Set<string>()): LibraryPage<T> {
  const requestedSize = Number(query.pageSize)
  const pageSize = [25, 50, 100].includes(requestedSize) ? requestedSize : 25
  const tokens = librarySearchTokens(query.q)
  const branches = new Map<string, { title: string; iconId?: string; hasGame: boolean; packages: number; readyDlc: number }>()
  const summary: LibrarySummary = { packages: items.length, games: 0, size: 0, installed: 0, delivered: 0, ready: 0, readyDlc: 0 }
  for (const item of items) {
    const branch = branches.get(item.titleId)
    if (!branch || (item.type === 'Игра' && !branch.hasGame)) {
      branches.set(item.titleId, { title: item.titleId === 'PFLS00001' ? 'PackageFlowService' : item.title, iconId: item.iconSize ? item.id : branch?.iconId, hasGame: item.type === 'Игра', packages: branch?.packages || 0, readyDlc: branch?.readyDlc || 0 })
    } else if (!branch.iconId && item.iconSize) branch.iconId = item.id
    const current = branches.get(item.titleId)!
    current.packages++
    if (item.type === 'DLC' && !item.installedAt) current.readyDlc++
    summary.size += item.size
    if (item.installedAt) summary.installed++
    if (deliveredIds.has(item.id)) summary.delivered++
    if (!item.installedAt) { summary.ready++; if (item.type === 'DLC') summary.readyDlc++ }
  }
  summary.games = branches.size
  const compare = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' }).compare
  const unit = query.unit === 'games' ? 'games' : 'packages'
  // A game card is one complete CUSA branch, even when its DLC has another name.
  const matchingIds = new Set(items.filter(item => matchesLibrarySearch(item, tokens)).map(item => item.titleId))
  const filtered = items.filter(item => unit === 'games' ? matchingIds.has(item.titleId) : matchesLibrarySearch(item, tokens)).sort((a, b) =>
    compare(branches.get(a.titleId)!.title, branches.get(b.titleId)!.title) || compare(a.titleId, b.titleId) ||
    a.installOrder - b.installOrder || compare(a.title, b.title) || compare(a.appVersion || '', b.appVersion || '') || compare(a.fileName, b.fileName) || compare(a.id, b.id))
  const gameIds = unit === 'games' ? [...new Set(filtered.map(item => item.titleId))] : []
  const total = unit === 'games' ? gameIds.length : filtered.length, pages = Math.max(1, Math.ceil(total / pageSize))
  const requestedPage = Number(query.page)
  const page = Math.min(pages, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1)
  const pageIds = new Set(gameIds.slice((page - 1) * pageSize, page * pageSize))
  const slice = unit === 'games' ? filtered.filter(item => pageIds.has(item.titleId)) : filtered.slice((page - 1) * pageSize, page * pageSize)
  const packages = slice.map(item => {
    const branch = branches.get(item.titleId)!
    return { ...item, groupTitle: branch.title, groupIconId: branch.iconId, groupPackages: branch.packages, groupReadyDlc: branch.readyDlc }
  })
  return { packages, page, pageSize, pages, total, unit, summary }
}
