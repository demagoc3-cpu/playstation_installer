import { getInstallationQueue } from '../../utils/installation-queue';

export default defineEventHandler((event) => getInstallationQueue(getQuery(event).ip?.toString()));
