export interface PresetPackage {
  id: string; titleId: string; contentId: string; digest?: string; fileName: string; title: string; groupTitle: string; type: string; size: number
}
export interface Preset { id: string; name: string; description?: string; packages: PresetPackage[]; createdAt: number; updatedAt: number }
export interface PresetSummary { id: string; name: string; description: string; covers: { title: string; iconId?: string }[]; games: number; files: number; size: number; available: number; missing: number; updatedAt: number }
export interface PresetItem extends PresetPackage { key: string; packageId?: string; available: boolean; iconId?: string; installed: boolean; contentId: string; appVersion?: string; masterVersion?: string; requiredFirmware?: string; sdkFirmware?: string; contentType?: string; packageDigest?: string }
export interface PresetPage extends PresetSummary { items: PresetItem[]; page: number; pages: number; total: number }
