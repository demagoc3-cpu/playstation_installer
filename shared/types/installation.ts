export type InstallationTransport = 'payload' | 'service'
export interface ServiceInstallJob {
  service: 'PackegeFlowService'
  jobId: string
  requestId: string
  contentId: string
  taskId: number
  state: 'registering' | 'downloading' | 'installing' | 'installed' | 'failed' | 'cancelling' | 'cancelled' | 'uncertain'
  totalBytes: number
  downloadedBytes: number
  downloadTotalBytes: number
  error: number
  errorHex: string
  pollError: number
}
export interface ServiceInstallCapabilities {
  service: 'PackegeFlowService'
  version: string
  installApi: 1
  ready: boolean
  authentication: 'bearer'
  contentTypes: string[]
  error: number
  errorHex: string
}
