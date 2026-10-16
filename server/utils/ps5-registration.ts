import type { Ps5Item } from './ps5-queue-core';
/** Registration of the requested BASE version + full installer coverage.
 * This is not a patch/DLC completion API or a gameplay check. */
export function ps5BaseRegistration(
  item: Ps5Item,
  job: Record<string, unknown>,
  receipt: { status: number; body: Record<string, unknown> },
) {
  return (
    item.order === 0 &&
    item.format === 'pkg' &&
    item.installDispatched === true &&
    !!item.serviceJobId &&
    item.bytesSent === item.size &&
    job.ok === true &&
    ['done', 'serving'].includes(String(job.phase)) &&
    job.code === 0 &&
    job.total === item.size &&
    job.bytes_served === item.size &&
    receipt.status === 200 &&
    receipt.body.title === item.titleId &&
    receipt.body.proof === 'base-registration' &&
    receipt.body.scope === 'internal-storage-only' &&
    receipt.body.contentPresent === true &&
    receipt.body.metadataMatch === true &&
    receipt.body.jobBound === true &&
    receipt.body.registered === true
  );
}
