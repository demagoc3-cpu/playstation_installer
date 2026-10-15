import { nativeCatalogV1 } from '../../../utils/native-catalog-v1';

export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  return nativeCatalogV1(getQuery(event));
});
