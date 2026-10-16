export type SearchPlatform = 'ps4' | 'ps5';

export const SEARCH_PLATFORM_CATEGORIES: Record<SearchPlatform, string> = {
  ps4: '1180',
  ps5: '100546',
};
export const DEFAULT_SEARCH_CATEGORIES = Object.values(SEARCH_PLATFORM_CATEGORIES).join(',');
