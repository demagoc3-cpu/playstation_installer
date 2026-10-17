import { createReadStream } from 'node:fs';
import { assertInstallationOrigin } from '../../../utils/installation-origin';
import {
  managementStatus,
  consoleCatalog,
  listPs5Saves,
  listPs5Backups,
  listPs5BackupJobs,
  startPs5Backup,
  ps5BackupJob,
  ps5BackupArchive,
  listPs5Restores,
  startPs5Restore,
  ps5RestoreJob,
  finishPs5Restore,
  setPs5SourceControlOverride,
} from '../../../utils/ps5-management';
import {
  ps5ConsoleActivity,
  ps5ConsoleGames,
  ps5ConsoleGameInfo,
  ps5ConsoleGameCommand,
  ps5ConsoleGameCommandStatus,
  ps5ConsoleStorageStatus,
} from '../../../utils/ps5-console-games';
export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  setHeader(event, 'Cache-Control', 'no-store');
  const body = await readBody(event),
    operation = getRouterParam(event, 'operation');
  switch (operation) {
    case 'game-activity':
      return ps5ConsoleActivity(body?.consoleId);
    case 'games':
      return ps5ConsoleGames(body?.consoleId);
    case 'game-info':
      return ps5ConsoleGameInfo(body?.consoleId, body?.titleId);
    case 'game-command':
      return ps5ConsoleGameCommand(body?.consoleId, body);
    case 'game-command-status':
      return ps5ConsoleGameCommandStatus(body?.consoleId, body?.requestId);
    case 'game-storage-status':
      return ps5ConsoleStorageStatus(body?.consoleId, body?.requestId);
    case 'status':
      return managementStatus(body?.consoleId);
    case 'source-control':
      return setPs5SourceControlOverride(body?.consoleId, body?.enabled);
    case 'catalog':
      return consoleCatalog(body?.consoleId);
    case 'saves':
      return listPs5Saves(body?.consoleId);
    case 'restores':
      return { jobs: listPs5Restores(body?.consoleId) };
    case 'restore':
      return startPs5Restore(
        body?.consoleId,
        body?.backupId,
        body?.requestId,
        body?.confirmTitleId,
      );
    case 'restore-job':
      return ps5RestoreJob(body?.consoleId, body?.requestId);
    case 'restore-finish':
      return finishPs5Restore(body?.consoleId, body?.requestId, body?.action, body?.confirmTitleId);
    case 'backups':
      return { backups: listPs5Backups(body?.consoleId), jobs: listPs5BackupJobs(body?.consoleId) };
    case 'backup':
      return startPs5Backup(body?.consoleId, body?.target, body?.requestId);
    case 'job':
      return ps5BackupJob(body?.consoleId, body?.requestId);
    case 'archive': {
      const archive = await ps5BackupArchive(body?.consoleId, String(body?.id || ''));
      setHeader(event, 'Content-Type', 'application/zip');
      setHeader(event, 'Content-Length', archive.size);
      setHeader(
        event,
        'Content-Disposition',
        `attachment; filename="PackageFlow-PS5-${archive.manifest.titleId}-${archive.manifest.id}.zip"`,
      );
      return sendStream(event, createReadStream(archive.archivePath));
    }
    default:
      throw createError({ statusCode: 404, message: 'Неизвестная операция PS5' });
  }
});
