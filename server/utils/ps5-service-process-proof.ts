/** Conservative FW 13.60 process proof, only for restarting the pinned saved ELF.
 * Names audited against PLDMGR 0.6.1 full processes_list after the owned process exited.
 * This is never a substitute for normal health, installation or PS4 admission. */
const SYSTEM_NAMES = new Set([
  'AgcCompositor.elf',
  'SceAIO',
  'SceAhciDDD',
  'SceAudit',
  'SceAvCapture',
  'SceAvControlThread',
  'SceBtDriver',
  'SceBufSpacedaemon0',
  'SceBufSpacedaemon1',
  'SceBufSpacedaemon2',
  'SceBufdaemon0',
  'SceBufdaemon1',
  'SceBufdaemon2',
  'SceCameraDriverMain',
  'SceCameraSdma',
  'SceCompanion',
  'SceCpuRv',
  'SceDaThrd',
  'SceDiscordDaemon',
  'SceGameLiveStreamin',
  'SceGbeMtsCtrl',
  'SceGbeMtsPhyCtrl',
  'SceHdmiEvent',
  'SceHidAuth',
  'SceHidMain',
  'SceHmd2ImuThread',
  'SceHmd2LogThread',
  'SceIccNotification',
  'SceIccThermal',
  'SceIccnvs',
  'SceIdleCpuRv',
  'SceJSCd',
  'SceMd0',
  'SceMd32',
  'SceMediaCoreServer',
  'SceNKNetworkProcess',
  'SceNKUIProcess',
  'SceNetemuWorker',
  'ScePartyDaemon',
  'ScePciStatusScanner',
  'ScePsNowClientDaemo',
  'SceRedisServer',
  'SceRemotePlay',
  'SceSflash',
  'SceShellCore',
  'SceShellUI',
  'SceSocialScreenMgr',
  'SceSpZeroConf',
  'SceSsdHealthKeeper',
  'SceSvmd',
  'SceSwapDev',
  'SceSwd',
  'SceSyncer',
  'SceSysAvControl.elf',
  'SceSysCore.elf',
  'SceSystemLogger2',
  'SceTrtwAsync',
  'SceTrtwCtrl',
  'SceTrtwIntr',
  'SceUmcWorker',
  'SceUpdatePupUtil',
  'SceVcnProc',
  'SceVmObjStat',
  'SceVnlru',
  'SceVoiceAndAgent',
  'SceVrTrackerDaemon',
  'cam',
  'fs_cleaner.elf',
  'geom',
  'idle',
  'intr',
  'kernel',
  'localpagedaemon',
  'mini-syscore.elf',
  'orbis_audiod.elf',
  'pagedaemon',
  'rand_harvestq',
  'usb',
  'webrtc_daemon.self',
]);
const BACKGROUND_PAYLOADS = new Set([
  'ftpsrv.elf',
  'nanodns.elf',
  'shadowmountplus.elf',
  'kstuff.elf',
  'pldmgr.elf',
  'elfldr.elf',
]);
export interface Ps5ManagerProcess {
  pid: number;
  name: string;
  memory: number;
  is_daemon: boolean;
}
export function checkedPs5StoppedProcesses(value: unknown): Ps5ManagerProcess[] {
  const fail = (): never => {
    throw new Error('PLDMGR не подтвердил полный список процессов без службы PackageFlow');
  };
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== 'processes')
  )
    return fail();
  const rows = (value as { processes?: unknown }).processes;
  if (!Array.isArray(rows) || rows.length < SYSTEM_NAMES.size + 2 || rows.length > 256)
    return fail();
  const pids = new Set<number>(),
    counts = new Map<string, number>();
  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !['pid', 'name', 'memory', 'is_daemon'].includes(key)) ||
      !Number.isSafeInteger(row.pid) ||
      row.pid < 0 ||
      row.pid > 2147483647 ||
      pids.has(row.pid) ||
      typeof row.name !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,31}$/.test(row.name) ||
      typeof row.memory !== 'number' ||
      !Number.isFinite(row.memory) ||
      row.memory < 0 ||
      row.memory > 65536 ||
      typeof row.is_daemon !== 'boolean'
    )
      return fail();
    const system = SYSTEM_NAMES.has(row.name),
      payload = BACKGROUND_PAYLOADS.has(row.name);
    if (
      (!system && !payload) ||
      row.is_daemon !== payload ||
      (row.pid === 0) !== (row.name === 'kernel') ||
      (row.name === 'mini-syscore.elf' && row.pid !== 1)
    )
      return fail();
    pids.add(row.pid);
    const count = (counts.get(row.name) || 0) + 1;
    if (count > (row.name === 'SceAIO' ? 2 : 1)) return fail();
    counts.set(row.name, count);
  }
  // Missing system anchors/rows can be a partial snapshot; never infer absence from it.
  if (
    [...SYSTEM_NAMES].some((name) => counts.get(name) !== (name === 'SceAIO' ? 2 : 1)) ||
    counts.get('pldmgr.elf') !== 1
  )
    return fail();
  return rows.map((row) => ({
    pid: row.pid,
    name: row.name,
    memory: row.memory,
    is_daemon: row.is_daemon,
  }));
}
