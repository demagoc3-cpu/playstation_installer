import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const work = await mkdtemp(join(tmpdir(), 'pf-payload-manager-'));
const outfile = join(work, 'api.mjs');
await build({
  entryPoints: ['server/utils/ps5-payload-manager.ts'],
  outfile,
  platform: 'node',
  format: 'esm',
  bundle: true,
  logLevel: 'silent',
});
const api = await import(pathToFileURL(outfile).href);
const ip = '192.168.50.5';
const filename = 'PackageFlowService-PS5.elf';
const own = {
  slot: 'local/packageflowservice',
  path: `/data/pldmgr/payloads/local/packageflowservice/${filename}`,
  filename,
  name: 'PackageFlowService-PS5',
  version: '0.1.29-dev',
  buildId: 'fixture',
};
const other = {
  slot: 'repo/kstuff@official',
  path: '/data/pldmgr/payloads/repo/kstuff@official/kstuff.elf',
  filename: 'kstuff.elf',
  name: 'kstuff',
  version: '1.0',
};
const bytes = Buffer.alloc(8192);
Buffer.from('7f454c460201', 'hex').copy(bytes);
bytes.writeUInt16LE(62, 18);
const artifact = {
  manifest: {
    fileName: filename,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    version: own.version,
    buildId: own.buildId,
    firmware: '13.60',
  },
  bytes,
};
const emptyCheck = {
  status: 'ok',
  folder_name: 'packageflowservice',
  folder_exists: false,
  file_exists: false,
  existing: null,
};

async function fixture(t, handle) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = {
      method: req.method,
      path: req.url,
      headers: req.headers,
      bytes: Buffer.concat(chunks),
    };
    calls.push(call);
    try {
      await handle(call, res);
    } catch (error) {
      res.destroy(error);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const transport = (options, respond) => {
    assert.equal(options.host, ip, 'production request remains bound to validated console IP');
    assert.equal(options.port, 8084, 'production PLDMGR port is fixed');
    assert.equal(options.agent, false);
    assert.equal(options.headers['X-PLDMGR-Request'], '1');
    return request({ ...options, host: '127.0.0.1', port: server.address().port }, respond);
  };
  return { calls, transport };
}
const replyJson = (res, value) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(value));
};

test('normalizes PLDMGR 0.5 path metadata and 0.6 slot metadata without trusting identity', async (t) => {
  for (const modern of [false, true]) {
    const payload = modern
      ? {
          items: [own, other],
          usb: [{ path: '/mnt/usb0/test.elf', filename: 'test.elf', slot: 'usb/test' }],
        }
      : {
          payloads: [own.path],
          meta: {
            [filename]: { display_name: own.name, version: own.version, build_id: own.buildId },
          },
        };
    const f = await fixture(t, ({ path }, res) => {
      if (path === '/version') res.end(modern ? '0.6.1' : '0.5.2');
      else if (path === '/list_payloads') replyJson(res, payload);
      else res.writeHead(404).end();
    });
    const manager = await api.readPs5PayloadManager(ip, f.transport);
    assert.equal(manager.version, modern ? '0.6.1' : '0.5.2');
    assert.deepEqual(manager.payloads[0], { ...own, slot: modern ? own.slot : '' });
    assert.equal(manager.payloads.length, modern ? 3 : 1);
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  }
});

test('process proof uses only the fixed PLDMGR GET endpoint and rejects a partial list', async (t) => {
  const { readFileSync } = await import('node:fs');
  const snapshot = JSON.parse(
    readFileSync('server/tests/fixtures/ps5-stopped-processes-1360.json', 'utf8'),
  );
  for (const complete of [true, false]) {
    const f = await fixture(t, ({ method, path }, res) => {
      assert.equal(method, 'GET');
      assert.equal(path, '/processes_list');
      replyJson(res, complete ? snapshot : { processes: snapshot.processes.slice(0, 5) });
    });
    if (complete)
      assert.equal(
        (await api.readPs5PayloadManagerProcesses(ip, f.transport)).length,
        snapshot.processes.length,
      );
    else await assert.rejects(api.readPs5PayloadManagerProcesses(ip, f.transport), /полный список/);
    assert.equal(f.calls.length, 1);
  }
});

test('launches exactly one listed canonical record using POST and the PLDMGR request marker', async (t) => {
  for (const selector of [own.slot, own.path]) {
    const f = await fixture(t, ({ path, method, bytes }, res) => {
      if (path === '/version') res.end('0.6.1');
      else if (path === '/list_payloads') replyJson(res, { items: [own, other] });
      else {
        assert.equal(method, 'POST');
        assert.equal(path, `/loadpayload:${selector}`);
        assert.equal(bytes.length, 0);
        res.end('OK');
      }
    });
    await api.launchPs5StoredPayload(ip, selector, f.transport);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(f.calls.length, 3);
  }
});

test('lost launch reply is dispatched and never causes a second POST; absent or ambiguous records never launch', async (t) => {
  for (const scenario of ['lost', 'missing', 'duplicate', 'foreign', 'usb']) {
    const duplicate = {
      ...own,
      path: `/data/pldmgr/payloads/repo/other@mirror/${filename}`,
      slot: 'repo/other@mirror',
    };
    const f = await fixture(t, ({ path }, res) => {
      if (path === '/version') res.end('0.6.1');
      else if (path === '/list_payloads')
        replyJson(res, {
          items:
            scenario === 'missing'
              ? []
              : scenario === 'duplicate'
                ? [own, duplicate]
                : scenario === 'foreign'
                  ? [other]
                  : scenario === 'usb'
                    ? [{ ...own, path: `/mnt/usb0/${filename}`, slot: 'usb/service' }]
                    : [own],
        });
      else res.socket.destroy();
    });
    const selector =
      scenario === 'foreign' ? other.slot : scenario === 'usb' ? 'usb/service' : own.slot;
    await assert.rejects(api.launchPs5StoredPayload(ip, selector, f.transport), (error) => {
      assert.ok(error instanceof api.PayloadManagerDispatchError);
      assert.equal(error.dispatched, scenario === 'lost');
      return true;
    });
    assert.equal(
      f.calls.filter((call) => call.method === 'POST').length,
      scenario === 'lost' ? 1 : 0,
    );
  }
});

test('a refused POST connection is distinguished from a launch with a lost response', async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const closedPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const f = await fixture(t, ({ path }, res) => {
    if (path === '/version') res.end('0.6.1');
    else replyJson(res, { items: [own] });
  });
  let postAttempts = 0;
  const transport = (options, respond) => {
    if (options.method !== 'POST') return f.transport(options, respond);
    postAttempts++;
    return request({ ...options, host: '127.0.0.1', port: closedPort }, respond);
  };
  await assert.rejects(api.launchPs5StoredPayload(ip, own.slot, transport), (error) => {
    assert.equal(error.dispatched, false);
    return true;
  });
  assert.equal(postAttempts, 1);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
});

test('explicit registration uploads exact bytes once into an empty own folder and preserves other entries', async (t) => {
  let uploaded = false;
  const f = await fixture(t, ({ path, method, bytes: received }, res) => {
    if (path === '/version') res.end('0.6.1');
    else if (path === '/list_payloads')
      replyJson(res, { items: uploaded ? [other, own] : [other] });
    else if (path === `/manage:check?filename=${filename}`) replyJson(res, emptyCheck);
    else if (path === `/manage:upload?filename=${filename}&mode=new`) {
      assert.equal(method, 'POST');
      assert.deepEqual(received, bytes);
      uploaded = true;
      res.end('OK');
    } else res.writeHead(404).end();
  });
  assert.deepEqual(await api.storePs5ServicePayload(ip, artifact, f.transport), own);
  assert.deepEqual(
    f.calls.map((call) => `${call.method} ${call.path}`),
    [
      'GET /version',
      'GET /list_payloads',
      `GET /manage:check?filename=${filename}`,
      `POST /manage:upload?filename=${filename}&mode=new`,
      'GET /version',
      'GET /list_payloads',
    ],
  );
});

test('registration refuses occupied, foreign, ambiguous and unverified folders before any write', async (t) => {
  for (const scenario of [
    'occupied',
    'foreign-folder',
    'unknown-state',
    'extra-file',
    'existing',
    'invalid-bytes',
  ]) {
    const f = await fixture(t, ({ path }, res) => {
      if (path === '/version') res.end('0.6.1');
      else if (path === '/list_payloads')
        replyJson(res, {
          items:
            scenario === 'existing'
              ? [own]
              : scenario === 'extra-file'
                ? [
                    {
                      ...other,
                      path: '/data/pldmgr/payloads/local/packageflowservice/other.elf',
                      slot: 'local/packageflowservice',
                      filename: 'other.elf',
                    },
                  ]
                : [],
        });
      else if (path.startsWith('/manage:check?'))
        replyJson(res, {
          ...emptyCheck,
          ...(scenario === 'occupied'
            ? { folder_exists: true, file_exists: true, existing: { slot: own.slot, filename } }
            : scenario === 'foreign-folder'
              ? { folder_name: 'elfldr' }
              : scenario === 'unknown-state'
                ? { folder_exists: undefined }
                : {}),
        });
      else res.writeHead(500).end();
    });
    const input =
      scenario === 'invalid-bytes' ? { ...artifact, bytes: Buffer.alloc(bytes.length) } : artifact;
    await assert.rejects(api.storePs5ServicePayload(ip, input, f.transport), (error) => {
      assert.equal(error.dispatched, false);
      return true;
    });
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  }
});

test('post-upload missing confirmation remains dispatched and is not retried', async (t) => {
  let uploaded = false;
  const f = await fixture(t, ({ path }, res) => {
    if (path === '/version') res.end('0.6.1');
    else if (path === '/list_payloads') replyJson(res, { items: [] });
    else if (path.startsWith('/manage:check?')) replyJson(res, emptyCheck);
    else {
      assert.equal(uploaded, false);
      uploaded = true;
      res.end('OK');
    }
  });
  await assert.rejects(api.storePs5ServicePayload(ip, artifact, f.transport), (error) => {
    assert.equal(error.dispatched, true);
    return true;
  });
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
});

test('canonical entry predicate describes an owned location without claiming version or byte identity', () => {
  assert.equal(api.isPs5StoredServicePayload(own), true);
  assert.equal(api.isPs5StoredServicePayload({ ...own, version: 'old', buildId: 'unknown' }), true);
  assert.equal(
    api.isPs5StoredServicePayload({
      ...own,
      slot: 'repo/packageflowservice-ps5@0123abcd',
      path: `/data/pldmgr/payloads/repo/packageflowservice-ps5@0123abcd/${filename}`,
    }),
    true,
  );
  assert.equal(
    api.isPs5StoredServicePayload({
      ...own,
      slot: '',
      path: `/data/pldmgr/payloads/PackageFlowService-PS5/${filename}`,
    }),
    true,
  );
  for (const changed of [
    { filename: 'PackageFlowInstaller-PS5.elf' },
    {
      slot: 'repo/foreign@0123abcd',
      path: `/data/pldmgr/payloads/repo/foreign@0123abcd/${filename}`,
    },
    { slot: '', path: `/mnt/usb0/${filename}` },
    { path: `/data/pldmgr/payloads/local/foreign/${filename}` },
  ])
    assert.equal(api.isPs5StoredServicePayload({ ...own, ...changed }), false);
});

test('an older canonical record is never replaced or deleted, including a slot containing another file', async (t) => {
  for (const sibling of [false, true]) {
    const old = { ...own, version: '0.1.28-dev', buildId: 'old-build' };
    const extra = {
      ...other,
      slot: own.slot,
      path: '/data/pldmgr/payloads/local/packageflowservice/personal.elf',
      filename: 'personal.elf',
    };
    const f = await fixture(t, ({ path }, res) => {
      if (path === '/version') res.end('0.6.1');
      else if (path === '/list_payloads') replyJson(res, { items: sibling ? [old, extra] : [old] });
      else res.writeHead(500).end('No slot replacement or check may be attempted');
    });
    await assert.rejects(api.storePs5ServicePayload(ip, artifact, f.transport), (error) => {
      assert.match(error.message, /уже сохранена/);
      assert.equal(error.dispatched, false);
      return true;
    });
    assert.deepEqual(
      f.calls.map((call) => `${call.method} ${call.path}`),
      ['GET /version', 'GET /list_payloads'],
    );
  }
});

test('unknown upload acknowledgement stays dispatched and never triggers replacement, launch or a replay', async (t) => {
  const f = await fixture(t, ({ path }, res) => {
    if (path === '/version') res.end('0.6.1');
    else if (path === '/list_payloads') replyJson(res, { items: [] });
    else if (path.startsWith('/manage:check?')) replyJson(res, emptyCheck);
    else res.end('accepted but no definite acknowledgement');
  });
  await assert.rejects(api.storePs5ServicePayload(ip, artifact, f.transport), (error) => {
    assert.equal(error.dispatched, true);
    return true;
  });
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(f.calls.every((call) => !/replace|delete|loadpayload|set_config/.test(call.path)));
});

test('fresh target or idle guard can prevent either launch or upload at its POST boundary', async (t) => {
  for (const operation of ['launch', 'store']) {
    const f = await fixture(t, ({ path }, res) => {
      if (path === '/version') res.end('0.6.1');
      else if (path === '/list_payloads')
        replyJson(res, { items: operation === 'launch' ? [own] : [] });
      else if (path.startsWith('/manage:check?')) replyJson(res, emptyCheck);
      else res.writeHead(500).end('A changed target must never receive a POST');
    });
    let guarded = false;
    const beforeDispatch = () => {
      guarded = true;
      assert.equal(
        f.calls.at(-1).path,
        operation === 'launch' ? '/list_payloads' : `/manage:check?filename=${filename}`,
      );
      throw Error('Target changed or queue is no longer idle');
    };
    await assert.rejects(
      operation === 'launch'
        ? api.launchPs5StoredPayload(ip, own.slot, f.transport, beforeDispatch)
        : api.storePs5ServicePayload(ip, artifact, f.transport, beforeDispatch),
      /Target changed/,
    );
    assert.equal(guarded, true);
    assert.ok(f.calls.every((call) => call.method === 'GET'));
  }
});

test('an asynchronous launch or upload guard is awaited and its rejection prevents every POST', async (t) => {
  for (const operation of ['launch', 'store']) {
    const f = await fixture(t, ({ path }, res) => {
      if (path === '/version') res.end('0.6.1');
      else if (path === '/list_payloads')
        replyJson(res, { items: operation === 'launch' ? [own] : [] });
      else if (path.startsWith('/manage:check?')) replyJson(res, emptyCheck);
      else res.writeHead(500).end('The rejected asynchronous guard must prevent this POST');
    });
    let settled = false;
    const beforeDispatch = async (fresh) => {
      await new Promise((done) => setImmediate(done));
      settled = true;
      if (operation === 'launch')
        assert.deepEqual(fresh, own, 'guard receives the fresh list entry');
      throw Error('Asynchronous target validation rejected dispatch');
    };
    await assert.rejects(
      operation === 'launch'
        ? api.launchPs5StoredPayload(ip, own.slot, f.transport, beforeDispatch)
        : api.storePs5ServicePayload(ip, artifact, f.transport, beforeDispatch),
      (error) => {
        assert.match(error.message, /Asynchronous target validation/);
        assert.equal(error.dispatched, false);
        return true;
      },
    );
    assert.equal(settled, true);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
  }
});

test('transport rejects arbitrary hosts, redirects, oversized responses and inconsistent paths', async (t) => {
  for (const invalid of [
    'localhost',
    '127.0.0.1',
    '192.168.50.5:8084',
    'http://192.168.50.5',
    '224.0.0.1',
  ]) {
    await assert.rejects(
      api.readPs5PayloadManager(invalid, () => {
        throw Error('must not connect');
      }),
      /IPv4/,
    );
  }
  for (const scenario of ['redirect', 'large', 'bad-path']) {
    const f = await fixture(t, ({ path }, res) => {
      if (scenario === 'redirect')
        res.writeHead(302, { Location: 'http://192.168.50.99:8084/version' }).end();
      else if (scenario === 'large') res.end('x'.repeat(1024 * 1024 + 1));
      else if (path === '/version') res.end('0.6.1');
      else
        replyJson(res, {
          items: [
            { ...own, path: '/data/pldmgr/payloads/local/../other/PackageFlowService-PS5.elf' },
          ],
        });
    });
    await assert.rejects(api.readPs5PayloadManager(ip, f.transport), (error) => {
      assert.equal(error.dispatched, false);
      return true;
    });
    assert.ok(f.calls.every((call) => call.method === 'GET'));
    assert.equal(f.calls.filter((call) => call.path === '/version').length, 1);
  }
});
test.after(() => rm(work, { recursive: true, force: true }));

test('autoload changes only our slot and verifies that nothing else changed', async (t) => {
  let config = {
    AUTOLOAD_ENABLED: true,
    AUTOLOAD_DELAY: 5,
    AUTOLOAD_LIST: 'repo/kstuff-lite@e8cce5d1,repo/shadowmountplus@e8cce5d1',
  };
  const f = await fixture(t, ({ method, path, bytes }, res) => {
    if (path === '/get_config') replyJson(res, config);
    else if (method === 'POST' && path === '/set_config') {
      config = { ...config, ...JSON.parse(bytes.toString('utf8')) };
      res.end('OK');
    } else res.writeHead(404).end();
  });
  assert.deepEqual(await api.setPs5ServiceAutoload(ip, true, own.slot, f.transport), [
    'repo/kstuff-lite@e8cce5d1',
    'repo/shadowmountplus@e8cce5d1',
    own.slot,
  ]);
  assert.equal(config.AUTOLOAD_DELAY, 5);
  const posts = f.calls.filter((call) => call.method === 'POST').length;
  await api.setPs5ServiceAutoload(ip, true, own.slot, f.transport);
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, posts, 'no-op is not sent');
  assert.deepEqual(await api.setPs5ServiceAutoload(ip, false, own.slot, f.transport), [
    'repo/kstuff-lite@e8cce5d1',
    'repo/shadowmountplus@e8cce5d1',
  ]);
  config.AUTOLOAD_LIST += ',local/packageflowservice-old';
  await assert.rejects(
    api.setPs5ServiceAutoload(ip, true, own.slot, f.transport),
    /другие записи PackageFlow/,
  );
});

test('replace keeps one service record and refuses when other records change', async (t) => {
  let items = [own, other];
  const f = await fixture(t, ({ method, path }, res) => {
    if (path === '/version') res.end('0.6.1');
    else if (path === '/list_payloads') replyJson(res, { items });
    else if (path.startsWith('/manage:check'))
      replyJson(res, { ...emptyCheck, folder_exists: true, file_exists: true });
    else if (method === 'POST' && path.startsWith('/manage:upload')) res.end('OK');
    else res.writeHead(404).end();
  });
  const saved = await api.replacePs5ServicePayload(ip, artifact, f.transport);
  assert.equal(saved.slot, own.slot);
  const upload = f.calls.find((call) => call.path.startsWith('/manage:upload'));
  assert.match(upload.path, /mode=replace$/, 'an existing record is replaced, never duplicated');
  assert.equal(upload.bytes.length, bytes.length);
  // A changed foreign record after the upload fails closed.
  const g = await fixture(t, ({ method, path }, res) => {
    if (path === '/version') res.end('0.6.1');
    else if (path === '/list_payloads') {
      replyJson(res, { items });
      if (g.calls.filter((call) => call.path === '/list_payloads').length === 1)
        items = [own, { ...other, version: '2.0' }];
    } else if (path.startsWith('/manage:check')) replyJson(res, emptyCheck);
    else if (method === 'POST') res.end('OK');
    else res.writeHead(404).end();
  });
  await assert.rejects(
    api.replacePs5ServicePayload(ip, artifact, g.transport),
    /не совпали с ожидаемыми/,
  );
});

test('delete removes exactly our record and diagnostics read history', async (t) => {
  let items = [own, other];
  const f = await fixture(t, ({ method, path }, res) => {
    if (path === '/version') res.end('0.6.1');
    else if (path === '/list_payloads') replyJson(res, { items });
    else if (method === 'POST' && path === '/manage:delete?slot=local%2Fpackageflowservice') {
      items = [other];
      res.end('OK');
    } else if (path === '/history_list') replyJson(res, { history: [own.path, 7] });
    else res.writeHead(404).end();
  });
  assert.equal(await api.deletePs5ServicePayload(ip, f.transport), true);
  assert.equal(await api.deletePs5ServicePayload(ip, f.transport), false, 'absent is not an error');
  assert.deepEqual(await api.readPs5PayloadManagerHistory(ip, f.transport), [own.path]);
});
