export interface SearchResult {
  id?: string
  title: string
  displayTitle: string
  source: string
  size: number
  seeders?: number
  leechers?: number
  peers?: number
  grabs?: number
  published?: string
  indexer?: string
  sourcePage?: string
  description?: string
  cover?: string
  categories: string[]
  platform?: string
  titleId?: string
  version?: string
  region?: string
  languages: string[]
  firmwareVersions: string[]
  backport: boolean
}

export interface SearchDetails {
  description?: string
  cover?: string
  fields: Array<{ label: string; value: string }>
  status: 'available' | 'unavailable'
  message?: string
}
