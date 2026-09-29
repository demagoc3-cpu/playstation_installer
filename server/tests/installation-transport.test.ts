import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installationTransport, serviceJobDetail, validServiceJob } from '../utils/installation-transport.ts'

test('payload is the default and unsupported choices never silently fall back', () => {
  assert.equal(installationTransport(undefined), 'payload')
  assert.equal(installationTransport('payload'), 'payload')
  assert.equal(installationTransport('service'), 'service')
  for (const value of ['auto', 'other', null, 1, {}, []]) assert.throws(() => installationTransport(value))
})
const job = { service: 'PackegeFlowService' as const, jobId: '11111111-1111-1111-1111-111111111111', requestId: '11111111-1111-1111-1111-111111111111',
  contentId: 'EP0000-CUSA00001_00-ABCDEFGHIJKLMNOP', taskId: 42, state: 'downloading' as const, totalBytes: 8589934592, downloadedBytes: 5368709120, downloadTotalBytes: 8589934592, error: 0, errorHex: '0x00000000', pollError: 0 }
test('service accepts 64-bit progress and distinguishes download from installation', () => {
  assert.ok(validServiceJob(job))
  assert.match(serviceJobDetail(job), /62%/)
  assert.match(serviceJobDetail({ ...job, downloadedBytes: job.totalBytes }), /100%/)
  assert.match(serviceJobDetail({ ...job, state: 'installing' }), /ожидаем подтверждение/)
  assert.match(serviceJobDetail({ ...job, state: 'installed' }), /подтверждена PS4/)
  assert.match(serviceJobDetail({ ...job, state: 'uncertain' }), /повтор не отправлен/)
  assert.match(serviceJobDetail({ ...job, state: 'downloading', pollError: -5 }), /временно недоступен/)
})
test('malformed job IDs, byte counts and unknown completion states are rejected', () => {
  for (const invalid of [{ state: 'done' }, { downloadedBytes: -1 }, { downloadedBytes: Number.MAX_SAFE_INTEGER + 1 }, { totalBytes: null },
    { requestId: 'different' }, { taskId: 1.5 }, { service: 'other' }, { errorHex: 'success' }]) assert.equal(validServiceJob({ ...job, ...invalid }), false)
})
