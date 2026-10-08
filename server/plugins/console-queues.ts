import { resumeConsoleQueues } from '../utils/installation-queue'
import { resumePs5Queues } from '../utils/ps5-installation-queue'
export default defineNitroPlugin(() => { resumeConsoleQueues(); resumePs5Queues() })
