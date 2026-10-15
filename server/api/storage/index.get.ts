import { storageManager } from '../../utils/storage-sources';
export default defineEventHandler(() => storageManager.list());
