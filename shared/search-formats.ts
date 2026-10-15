import type { ContentFormat } from './types/consoles';

export type SearchReleaseFormat = Exclude<ContentFormat, 'unknown'>;

const formatLabel =
  /^(?:формат(?:\s+(?:игры|раздачи|образа|дампа|пакета))?|тип\s+(?:дампа|раздачи|релиза|пакета)|(?:release\s+|dump\s+|package\s+)?format|(?:dump|release|package)\s+type)$/i;
const markers: Array<[SearchReleaseFormat, RegExp]> = [
  ['pkg', /\b(?:pkg|fpkg)\b/i],
  ['folder', /\bfolder\b|(?:^|[\s[(,])папк(?:а|и|ой|ами)(?=$|[\s\]),])/i],
  ['ufs2', /\b(?:ufs2|ffpkg)\b/i],
  ['exfat', /\bexfat\b/i],
  ['pfs', /\b(?:pfs|ffpfs)\b/i],
  ['ffpfsc', /\bffpfsc\b/i],
];

/** Release labels describe the source's claims, not inspected downloaded files. */
export function searchReleaseFormats(
  title: string,
  description = '',
  fields: Array<{ label: string; value: string }> = [],
  platform?: string,
): SearchReleaseFormat[] {
  if (platform?.toLowerCase() === 'ps4') return ['pkg'];
  const values = [title];
  for (const line of description.split('\n')) {
    const separator = line.indexOf(':');
    if (separator >= 0 && formatLabel.test(line.slice(0, separator).trim()))
      values.push(line.slice(separator + 1));
  }
  for (const field of fields) if (formatLabel.test(field.label.trim())) values.push(field.value);
  const text = values.join('\n');
  return markers.filter(([, pattern]) => pattern.test(text)).map(([format]) => format);
}
