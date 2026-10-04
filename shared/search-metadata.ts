/** These labels describe the release title; they are not verified PKG metadata. */
export function searchTitleMetadata(title: string, categories: string[] = []) {
  const platform = /\bPS4\b/i.test(title) ? 'PS4' : /\bPS5\b/i.test(title) ? 'PS5' : categories.includes('1180') ? 'PS4' : undefined
  const titleId = title.match(/\b(?:CUSA|PPSA)\d{5}\b/i)?.[0].toUpperCase()
  const region = title.match(/\b(EUR|USA|JPN|ASIA|WORLD)\b/i)?.[0].toUpperCase()
  const version = title.match(/(?:\b(?:v|ver(?:sion)?|версия)\s*[:.]?\s*)(\d{1,2}\.\d{2})(?!\d)/i)?.[1]
    || title.match(/\[(\d{1,2}\.\d{2})\]/)?.[1]
  const languages: string[] = []
  if (/\b(?:RUS|RU|Russian)\b|рус(?:ский|ская|ификация)/i.test(title)) languages.push('Русский')
  if (/\b(?:ENG|EN|English)\b/i.test(title)) languages.push('English')
  if (/\bMULTI\b/i.test(title)) languages.push('Мультиязычная')
  const backport = /\bbackport\b|б[эе]кпорт/i.test(title)
  const firmwareSegment = title.match(/(?:backport|б[эе]кпорт|\bFW|firmware|прошивк[аи])\s*[:+\-]?\s*\[?([\d.\s/,+-]+)/i)?.[1]
  const firmwareVersions = [...new Set(firmwareSegment?.match(/\d{1,2}\.\d{2}/g) || [])]
  const displayTitle = title.replace(/\[[^\]]*\]/g, ' ').replace(/\b(?:PS4|PS5|Backport)\b|б[эе]кпорт/gi, ' ').replace(/\s*\+\s*$/g, '').replace(/\s+/g, ' ').trim() || title
  return { displayTitle, platform, titleId, version, region, languages, firmwareVersions, backport }
}
