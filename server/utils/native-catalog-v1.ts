import { legacyConsoleIp } from './console-scope'
import { filterContent, contentPlatform, contentFormat } from '../../shared/content-platform'
import { getLibraryPackages } from './package-library'
import { buildConsoleCatalog } from './console-catalog'
import { nativeInstallReviewCapability } from './native-install-review'
import { gameDetails } from '../../shared/game-details'

import type { ConsoleCatalogQuery } from './console-catalog'

export function nativeCatalogV1(query: ConsoleCatalogQuery & {lang?: unknown; platform?: unknown; ip?: unknown}) {
  // PS4 remains the default for old clients. Explicit all/ps5 only expands
  // browsing; installation APIs still enforce the target console platform.
  const platform = ['all','ps4','ps5'].includes(String(query.platform)) ? String(query.platform) : 'ps4'
  const packages = filterContent(getLibraryPackages(query.ip?.toString() || legacyConsoleIp()), platform)
  const result = buildConsoleCatalog(packages, query.lang === 'en' ? 'en' : 'ru', query)
  const index = new Map(packages.map(item=>[item.id,item]))
  return { ...result, platform, capabilities: { ...result.capabilities, installReview: nativeInstallReviewCapability(), catalogFeatures:{schemaVersion:1,platformFilter:true,gameDetails:true,packageMetadata:true} },
    games:result.games.map(game=>({...game,platform:contentPlatform(index.get(game.packages[0]?.id || '') || {}),details:gameDetails(game.packages.map(p=>index.get(p.id)!)),
      packages:game.packages.map(p=>{const source=index.get(p.id)!;return {...p,platform:contentPlatform(source),format:contentFormat(source),signature:source.signature || 'unknown',contentId:source.contentId || '',sdkFirmware:source.sdkFirmware || '',details:gameDetails([source])}})})) }
}
