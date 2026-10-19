import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
test('PS5 Games targets a concrete profile, rejects partial/stale source data and never replays an uncertain mutation', async () => {
  const work = mkdtempSync(join(tmpdir(), 'pf-games-web-')),
    previous = process.env.PACKAGEFLOW_DATA_DIR;
  process.env.PACKAGEFLOW_DATA_DIR = join(work, 'data');
  let sourceControls,
    controls = true,
    sourceStatus = 200,
    sourceError,
    badPage = false,
    commands = 0,
    lose = false,
    current = 'a'.repeat(64),
    pending = false,
    activeGame = { complete: true, running: false, appId: 0, titleId: '' };
  const row = {
    title_id: 'PPSA00001',
    title_name: 'Fixture',
    platform: 'ps5',
    source_type: 'folder',
    image_type: '',
    path: '/data/homebrew/PPSA00001',
    runtime_path: '/mnt/title',
    version: '01.000.000',
    content_id: 'fixture',
    installed: true,
    mounted: true,
    managed: true,
    source_available: true,
    can_uninstall: true,
    can_manage_source: true,
    size_status: 0,
    size_bytes: 1024,
    app_db_size_bytes: 63 * 1048576,
    sourceIdentity: current,
  };
  globalThis.pfGameFixture = {
    profile: (id) => ({
      id,
      platform: id === 'ps4' ? 'ps4' : 'ps5',
      ip: id === 'a' ? '192.168.1.5' : '192.168.1.6',
    }),
    caps: () => ({
      ready: true,
      consoleGames: controls,
      consoleControl: controls,
      consoleActivity: controls,
      consoleSourceControl: sourceControls,
    }),
    catalog: () => ({ entries: [{ titleId: 'PPSA00001', title: 'Fallback', platform: 'ps5' }] }),
    queue: () => ({ items: pending ? [{ state: 'sending' }] : [] }),
    async operation(id, path, h) {
      assert.equal(id, 'a');
      if (path === '/api/v1/console/activity') return { status: 200, body: activeGame };
      if (path === '/api/v1/console/games')
        return {
          status: sourceStatus,
          body: {
            error: sourceError,
            revision: 'b'.repeat(64),
            entries: [row],
            total: badPage ? 2 : 1,
            next: 1,
            done: true,
          },
        };
      if (path === '/api/v1/console/info')
        return { status: 200, body: { ...row, sourceIdentity: current } };
      if (path === '/api/v1/console/command') {
        commands++;
        if (h['X-PackageFlow-Action'] === 'delete')
          assert.equal(h['X-PackageFlow-Confirm-Title'], row.title_id);
        if (lose) throw Error('response lost');
        return {
          status: 200,
          body: {
            requestId: h['X-PackageFlow-Request-Id'],
            titleId: row.title_id,
            action: h['X-PackageFlow-Action'],
            state: 'accepted',
          },
        };
      }
      if (path === '/api/v1/console/command/status')
        return {
          status: 200,
          body: {
            requestId: h['X-PackageFlow-Request-Id'],
            titleId: row.title_id,
            action: 'delete',
            state: 'unconfirmed',
          },
        };
      throw Error('unknown ' + path);
    },
  };
  try {
    const outfile = join(work, 'api.cjs');
    await build({
      entryPoints: ['server/utils/ps5-console-games.ts'],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'fixture',
          setup(b) {
            b.onResolve(
              {
                filter:
                  /^\.\/(console-profiles|package-library|ps5-management|ps5-installation-queue|ps5-service-updates)$/,
              },
              (a) => ({ path: a.path, namespace: 'fixture' }),
            );
            b.onLoad({ filter: /.*/, namespace: 'fixture' }, (a) => ({
              contents: a.path.endsWith('console-profiles')
                ? 'export const getConsoleProfile=(...a)=>globalThis.pfGameFixture.profile(...a);export const ps5OperationRequest=(...a)=>globalThis.pfGameFixture.operation(...a)'
                : a.path.endsWith('package-library')
                  ? 'export const getLibraryPackages=()=>[]'
                  : a.path.endsWith('ps5-management')
                    ? 'export const managementStatus=async()=>globalThis.pfGameFixture.caps();export const consoleCatalog=async()=>globalThis.pfGameFixture.catalog()'
                    : a.path.endsWith('ps5-installation-queue')
                      ? 'export const getPs5Queue=()=>globalThis.pfGameFixture.queue()'
                      : 'export const assertNoPs5ServiceUpdate=()=>{}',
              loader: 'js',
            }));
          },
        },
      ],
    });
    const api = createRequire(import.meta.url)(outfile);
    assert.equal(
      (await api.ps5ConsoleGames('a')).entries[0].sizeBytes,
      1024,
      'use measured source size, not registration63MB',
    );
    await assert.rejects(api.ps5ConsoleGames('ps4'), /PS5/);
    badPage = true;
    await assert.rejects(api.ps5ConsoleGames('a'), /Список игр изменился/);
    badPage = false;
    const input = {
      requestId: 'a'.repeat(32),
      titleId: row.title_id,
      action: 'delete',
      sourceIdentity: 'a'.repeat(64),
      confirmTitleId: row.title_id,
    };
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...input, confirmTitleId: 'PPSA00002' }),
      /Подтвердите/,
    );
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', {
        ...input,
        requestId: 'f'.repeat(32),
        action: 'unpack',
        destination: '/data/homebrew',
      }),
      /Распаковка/,
    );
    assert.equal(commands, 0);
    pending = true;
    await assert.rejects(api.ps5ConsoleGameCommand('a', input), /очереди/);
    pending = false;
    current = 'c'.repeat(64);
    await assert.rejects(api.ps5ConsoleGameCommand('a', input), /изменились/);
    current = 'a'.repeat(64);
    lose = true;
    assert.equal((await api.ps5ConsoleGameCommand('a', input)).state, 'unconfirmed');
    assert.equal(commands, 1);
    assert.equal((await api.ps5ConsoleGameCommand('a', input)).state, 'unconfirmed');
    assert.equal(commands, 1, 'repeat reads GET ledger, does not POST');
    await assert.rejects(api.ps5ConsoleGameCommand('b', input), /другой операции/);
    await assert.rejects(
      api.ps5ConsoleGameCommandStatus('a', '9'.repeat(32)),
      (e) =>
        e.statusCode === 404 &&
        e.data.commandRecordMissing === true &&
        !e.message.includes('ENOENT'),
    );
    lose = false;
    const restoreDir = join(process.env.PACKAGEFLOW_DATA_DIR, 'ps5-save-restores');
    mkdirSync(restoreDir, { recursive: true });
    const restoreId = 'd'.repeat(32),
      target = { titleId: 'PPSA00002', userId: 'aabbccdd', kind: 'native' };
    const restore = {
      id: restoreId,
      consoleId: 'a',
      sourceIp: '192.168.1.5',
      state: 'pending',
      target,
      receipt: { requestId: restoreId, ...target, state: 'pending' },
    };
    const saveRestore = () =>
      writeFileSync(join(restoreDir, restoreId + '.json'), JSON.stringify(restore));
    saveRestore();
    const launch = { ...input, requestId: '1'.repeat(32), action: 'launch' };
    assert.equal(
      (await api.ps5ConsoleGameCommand('a', launch)).state,
      'accepted',
      'allow playing while an applied restore awaits progress review, including another game',
    );
    assert.equal(
      (
        await api.ps5ConsoleGameCommand('a', {
          ...launch,
          requestId: '2'.repeat(32),
          action: 'stop',
        })
      ).state,
      'accepted',
    );
    let before = commands;
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...input, requestId: '3'.repeat(32) }),
      (e) => e.data.commandNotDispatched === true && /восстановление/.test(e.message),
    );
    assert.equal(commands, before, 'pending review does not enable storage mutations');
    for (const state of ['checking', 'uploading', 'applying', 'uncertain']) {
      restore.state = state;
      saveRestore();
      await assert.rejects(
        api.ps5ConsoleGameCommand('a', { ...launch, requestId: '4'.repeat(32) }),
        (e) => e.data.commandNotDispatched === true,
      );
    }
    restore.state = 'pending';
    restore.receipt.state = 'applying';
    saveRestore();
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...launch, requestId: '4'.repeat(32) }),
      /восстановление/,
    );
    restore.receipt.state = 'pending';
    restore.sourceIp = '192.168.1.7';
    saveRestore();
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...launch, requestId: '4'.repeat(32) }),
      /восстановление/,
    );
    assert.equal(commands, before, 'busy, uncertain and mismatched receipts never dispatch launch');
    rmSync(restoreDir, { recursive: true, force: true });
    activeGame = { complete: true, running: true, appId: 42, titleId: 'PPSA00002' };
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...launch, requestId: '5'.repeat(32) }),
      (e) => e.data.commandNotDispatched === true && e.data.activeGame.appId === 42,
    );
    assert.equal(commands, before, 'a running game blocks a new launch before dispatch');
    activeGame = { complete: true, running: false, appId: 0, titleId: 'PPSA00002' };
    await assert.rejects(api.ps5ConsoleActivity('a'), /определить/);
    activeGame = { complete: true, running: false, appId: 0, titleId: '' };
    rmSync(restoreDir, { recursive: true, force: true });
    sourceControls = false;
    before = commands;
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...input, requestId: '8'.repeat(32) }),
      /Изменение исходных файлов/,
    );
    assert.equal(commands, before, 'launch qualification never authorizes source deletion');
    assert.equal(
      (await api.ps5ConsoleGameCommand('a', { ...launch, requestId: '7'.repeat(32) })).state,
      'accepted',
    );
    const original = { ...row },
      own = {
        ...input,
        requestId: '6'.repeat(32),
        titleId: 'PPSA95001',
        confirmTitleId: 'PPSA95001',
      };
    Object.assign(row, {
      title_id: 'PPSA95001',
      content_id: 'IV0000-PPSA95001_00-PACKAGEFLOWUI001',
      source_type: 'image',
      image_type: 'ufs',
      path: '/data/homebrew/PPSA95001.ffpkg',
    });
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...own, bundledPackageFlowUpdate: true }),
      /Изменение исходных файлов/,
      'a browser body flag never grants this server permission',
    );
    row.content_id = 'FOREIGN';
    before = commands;
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', own, { bundledPackageFlowUpdate: true }),
      /Источник приложения/,
    );
    assert.equal(commands, before);
    row.content_id = 'IV0000-PPSA95001_00-PACKAGEFLOWUI001';
    assert.equal(
      (await api.ps5ConsoleGameCommand('a', own, { bundledPackageFlowUpdate: true })).state,
      'accepted',
    );
    Object.assign(row, original);
    sourceControls = undefined;
    controls = false;
    const readable = await api.ps5ConsoleGames('a');
    assert.equal(
      readable.entries[0].title,
      'Fixture',
      'missing control qualification must not hide readable source files',
    );
    assert.equal(readable.entries[0].sourceType, 'folder');
    assert.equal(readable.entries[0].sourceAvailable, true);
    assert.equal(readable.capabilities.consoleSourcesRead, true);
    assert.equal(readable.capabilities.consoleControl, false);
    assert.equal(readable.capabilities.consoleActivity, false);
    before = commands;
    await assert.rejects(
      api.ps5ConsoleGameCommand('a', { ...input, requestId: 'b'.repeat(32) }),
      /испытанием/,
    );
    assert.equal(commands, before, 'read-only discovery must not enable mutations');
    badPage = true;
    await assert.rejects(api.ps5ConsoleGames('a'), /Список игр изменился/);
    badPage = false;
    for (const status of [404, 405, 410, 503]) {
      sourceStatus = status;
      const legacy = await api.ps5ConsoleGames('a');
      assert.equal(legacy.entries[0].title, 'Fallback');
      assert.equal(legacy.entries[0].canUninstall, false);
      assert.equal(legacy.entries[0].canManageSource, false);
      assert.equal(legacy.capabilities.consoleSourcesRead, false);
      assert.ok(legacy.sourceMessage);
    }
    for (const status of [401, 403, 500]) {
      sourceStatus = status;
      await assert.rejects(api.ps5ConsoleGames('a'), /отклонила чтение/);
    }
    controls = true;
    sourceStatus = 503;
    await assert.rejects(api.ps5ConsoleGames('a'), /отклонила чтение/);
    sourceError = 'shadowmount_api_unavailable';
    await assert.rejects(api.ps5ConsoleGames('a'), /API ShadowMount недоступен/);
    controls = false;
    const unavailable = await api.ps5ConsoleGames('a');
    assert.match(unavailable.sourceMessage, /API ShadowMount недоступен/);
    assert.match(unavailable.sourceMessage, /Процесс может быть запущен/);
    assert.equal(unavailable.entries[0].title, 'Fallback');
    assert.equal(unavailable.capabilities.consoleSourcesRead, false);
    assert.equal(unavailable.entries[0].canManageSource, false);
    assert.equal(commands, before, 'backend error display never dispatches a mutation');
    sourceError = undefined;
    controls = true;
    sourceStatus = 200;
    assert.throws(() => api.normalizePs5Game({ ...row, can_manage_source: undefined }), /Неполные/);
    assert.throws(() => api.normalizePs5Game({ ...row, title_id: '../bad' }), /Некорректная/);
  } finally {
    delete globalThis.pfGameFixture;
    if (previous === undefined) delete process.env.PACKAGEFLOW_DATA_DIR;
    else process.env.PACKAGEFLOW_DATA_DIR = previous;
    rmSync(work, { recursive: true, force: true });
  }
});
