import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocal, serviceEnv, checkService } from '../../scripts/poc-local.mjs';
import { listEmployees } from '../../src/people.ts';

const PRIVATE_DETAIL = 'test-only-private-failure';

/** 起動管理だけのfixtureであり、実HTTPやモデル分類の成功は表さない。 */
function successfulReport() {
  return {
    transport: 'test-only', summary: { matched: 19, total: 19, criterion_met: true },
    results: Array.from({ length: 19 }, (_, index) => ({ sampleID: `fixture-${index}`, matched: true })),
  };
}

/** 実プロセスを作らず、自分が起動したサービスの停止だけを数える。 */
function harness(overrides = {}) {
  const launched = [];
  const stopped = [];
  const saved = [];
  const logs = [];
  const report = successfulReport();
  let probeCalls = 0;
  const options = {
    check: async () => true,
    launch: (service) => {
      launched.push(service);
      return { exited: new Promise(() => {}), stop: async () => { stopped.push(service); } };
    },
    probe: async () => { probeCalls += 1; return report; },
    save: async (value) => { saved.push(value); },
    sleep: async () => assert.fail('起動確認が即時成功するケースでは待機しない'),
    log: (line) => { logs.push(line); },
    installSignals: false, port: 8766,
    ...overrides,
  };
  return { options, launched, stopped, saved, logs, report, probeCalls: () => probeCalls };
}

test('両サービスが起動済みなら再利用し、19件smokeを保存して既存プロセスを停止しない', async () => {
  const checked = [];
  const h = harness({ check: async (service) => { checked.push(service); return true; } });
  assert.equal(await runLocal('smoke', h.options), 0);
  assert.deepEqual(checked, ['local-jev', 'app']);
  assert.deepEqual(h.launched, []);
  assert.deepEqual(h.stopped, []);
  assert.equal(h.probeCalls(), 1);
  assert.deepEqual(h.saved, [h.report]);
  assert.ok(h.logs.some((line) => line.includes('19/19')));
});

test('不足する2サービスだけを起動し、再確認後のsmoke完了時に自分の子を両方停止する', async () => {
  const checks = new Map();
  const h = harness({ check: async (service) => {
    const count = (checks.get(service) ?? 0) + 1;
    checks.set(service, count);
    return count > 1;
  } });
  assert.equal(await runLocal('smoke', h.options), 0);
  assert.deepEqual(h.launched, ['local-jev', 'app']);
  assert.deepEqual(h.stopped, ['local-jev', 'app']);
  assert.deepEqual([...checks], [['local-jev', 2], ['app', 2]]);
  assert.deepEqual(h.saved, [h.report]);
});

test('2つ目の起動確認やprobeが失敗しても、自分の全サービスを片付けて終了1を返す', async () => {
  for (const failure of ['second-check', 'probe']) {
    const checks = new Map();
    const h = harness({
      check: async (service) => {
        const count = (checks.get(service) ?? 0) + 1;
        checks.set(service, count);
        if (failure === 'second-check' && service === 'app' && count === 2) throw new Error(PRIVATE_DETAIL);
        return count > 1;
      },
      probe: async () => { throw new Error(PRIVATE_DETAIL); },
    });
    assert.equal(await runLocal('smoke', h.options), 1);
    assert.deepEqual(h.launched, ['local-jev', 'app']);
    assert.deepEqual(h.stopped, ['local-jev', 'app']);
    assert.deepEqual(h.saved, []);
    assert.equal(h.logs.join('\n').includes(PRIVATE_DETAIL), false);
  }
});

test('子プロセスが起動確認中に終了した場合も、作成した全サービスを停止する', async () => {
  const launched = [];
  const stopped = [];
  const checks = new Map();
  const h = harness({
    check: async (service) => {
      const count = (checks.get(service) ?? 0) + 1;
      checks.set(service, count);
      if (service === 'app' && count > 1) return new Promise(() => {});
      return count > 1;
    },
    launch: (service) => {
      launched.push(service);
      return {
        exited: service === 'app' ? Promise.reject(new Error(PRIVATE_DETAIL)) : new Promise(() => {}),
        stop: async () => { stopped.push(service); },
      };
    },
  });
  assert.equal(await runLocal('smoke', h.options), 1);
  assert.deepEqual(launched, ['local-jev', 'app']);
  assert.deepEqual(stopped, ['local-jev', 'app']);
  assert.equal(h.probeCalls(), 0);
  assert.deepEqual(h.saved, []);
  assert.equal(h.logs.join('\n').includes(PRIVATE_DETAIL), false);
});

test('起動期限は偽時計で判定し、時間切れで自分の子を停止してprobeを呼ばない', async () => {
  let clock = 0;
  const waits = [];
  const h = harness({
    check: async () => false,
    now: () => clock,
    sleep: async (duration) => { waits.push(duration); clock += duration; },
    timeoutMs: 1000,
  });
  assert.equal(await runLocal('smoke', h.options), 1);
  assert.deepEqual(waits, [500, 500]);
  assert.equal(clock, 1000);
  assert.deepEqual(h.launched, ['local-jev']);
  assert.deepEqual(h.stopped, ['local-jev']);
  assert.equal(h.probeCalls(), 0);
  assert.deepEqual(h.saved, []);
  assert.ok(h.logs.some((line) => line.includes('時間切れ')));
});

test('子の環境は実行用allowlistと固定設定だけで、偽トークンやモデル変更を継承しない', () => {
  const allowed = {
    PATH: '/test-only/bin', LD_LIBRARY_PATH: '/test-only/lib', TMPDIR: '/test-only/tmpdir',
    TMP: '/test-only/tmp', TEMP: '/test-only/temp', LANG: 'ja_JP.UTF-8', LC_ALL: 'C.UTF-8',
  };
  const fake = {
    ...allowed, TYPESAFE_API_KEY: 'fake-key', HF_TOKEN: 'fake-token', INUI_GITHUB_MCP_TOKEN: 'fake-github',
    AWS_ACCESS_KEY_ID: 'fake-aws', AWS_SECRET_ACCESS_KEY: 'fake-secret', AWS_SESSION_TOKEN: 'fake-session',
    GH_TOKEN: 'fake-gh', GITHUB_TOKEN: 'fake-github', HOME: '/test-only/home',
    LOCAL_JEV_MODEL: 'nli-multilingual-minilm', HF_HOME: '/test-only/other-cache',
    LOCAL_JEV_MODELS: '/test-only/other-models', NODE_ENV: 'development', HF_HUB_OFFLINE: '0', INUI_POC_PORT: '8766', LOG_LEVEL: 'debug',
  };
  const original = structuredClone(fake);
  const env = serviceEnv(fake);
  for (const [key, value] of Object.entries(allowed)) assert.equal(env[key], value);
  assert.deepEqual(Object.keys(env).sort(), [...Object.keys(allowed), 'NODE_ENV', 'INUI_POC_PORT', 'LOG_LEVEL', 'HF_HOME', 'LOCAL_JEV_MODELS',
    'HF_HUB_OFFLINE', 'TRANSFORMERS_OFFLINE', 'HF_HUB_DISABLE_IMPLICIT_TOKEN',
    'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS'].sort());
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.INUI_POC_PORT, '8766');
  assert.equal(serviceEnv({}).INUI_POC_PORT, '8766');
  assert.equal(env.LOG_LEVEL, 'debug');
  assert.equal(serviceEnv({}).LOG_LEVEL, 'info');
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.TRANSFORMERS_OFFLINE, '1');
  assert.equal(env.HF_HUB_DISABLE_IMPLICIT_TOKEN, '1');
  assert.equal(env.OMP_NUM_THREADS, '4');
  assert.equal(env.MKL_NUM_THREADS, '4');
  assert.equal(env.OPENBLAS_NUM_THREADS, '4');
  assert.equal(env.HF_HOME, new URL('../../.local-jev/cache', import.meta.url).pathname);
  assert.equal(env.LOCAL_JEV_MODELS, new URL('../../.local-jev/models', import.meta.url).pathname);
  assert.equal(Object.hasOwn(env, 'LOCAL_JEV_MODEL'), false);
  assert.deepEqual(fake, original);
});

test('子へ渡すログレベルは許可値だけにし、不正な環境値を転送しない', () => {
  for (const level of ['debug', 'info', 'warn', 'error']) {
    assert.equal(serviceEnv({ LOG_LEVEL: level }).LOG_LEVEL, level);
  }
  for (const invalid of ['', 'trace', 'DEBUG', PRIVATE_DETAIL]) {
    const env = serviceEnv({ LOG_LEVEL: invalid });
    assert.equal(env.LOG_LEVEL, 'info');
    assert.equal(JSON.stringify(env).includes(PRIVATE_DETAIL), false);
  }
});

test('health確認はappと固定NLIを識別し、接続拒否だけを未起動として扱う', async () => {
  const urls = [];
  const healthy = async (url, init) => {
    urls.push(url);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json(url.includes(':8766/') ? { employees: listEmployees() }
      : { ok: true, default_model: 'nli-deberta-large' });
  };
  assert.equal(await checkService('app', healthy, 8766), true);
  assert.equal(await checkService('local-jev', healthy, 8766), true);
  assert.deepEqual(urls, ['http://127.0.0.1:8766/api/employees', 'http://127.0.0.1:8765/healthz']);
  for (const service of ['app', 'local-jev']) {
    assert.equal(await checkService(service, async () => {
      throw new Error(PRIVATE_DETAIL, { cause: { code: 'ECONNREFUSED' } });
    }, 8766), false);
    for (const fetchImpl of [
      async () => Response.json({}, { status: 503 }),
      async () => Response.json({ employees: [], ok: true, default_model: 'other-model' }),
      async () => { throw new Error(PRIVATE_DETAIL, { cause: { code: 'EPERM' } }); },
      async () => ({ ok: true, status: 200, json: async () => { throw new Error(PRIVATE_DETAIL); } }),
    ]) {
      await assert.rejects(checkService(service, fetchImpl, 8766), (error) => {
        assert.equal(error.message.includes(PRIVATE_DETAIL), false);
        return true;
      });
    }
  }
});

test('選択した18766を起動確認・子への設定・smoke・案内URLで共有し、NLIは8765に保つ', async () => {
  const checked = [];
  const launched = [];
  const h = harness({
    port: 18766,
    check: async (service, _fetchImpl, port) => {
      checked.push([service, port]);
      return launched.some(([name]) => name === service);
    },
    launch: (service, port) => {
      launched.push([service, port]);
      return { exited: new Promise(() => {}), stop: async () => {} };
    },
    probe: async ({ port }) => { assert.equal(port, 18766); return successfulReport(); },
  });
  assert.equal(await runLocal('smoke', h.options), 0);
  assert.deepEqual(launched, [['local-jev', 18766], ['app', 18766]]);
  assert.ok(checked.every(([, port]) => port === 18766));
  assert.ok(h.logs.some((line) => line.includes('http://127.0.0.1:18766/') && line.includes(':18766/legacy')));
  assert.equal(h.logs.some((line) => line.includes(':8766/')), false);
  assert.equal(serviceEnv({}, 18766).INUI_POC_PORT, '18766');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return Response.json(url.includes(':18766/') ? { employees: listEmployees() } : { ok: true, default_model: 'nli-deberta-large' });
  };
  assert.equal(await checkService('app', fetchImpl, 18766), true);
  assert.equal(await checkService('local-jev', fetchImpl, 18766), true);
  assert.deepEqual(urls, ['http://127.0.0.1:18766/api/employees', 'http://127.0.0.1:8765/healthz']);
});

test('不正なポートはサービス確認や起動の前に安全なエラーにし、子へ渡さない', async () => {
  for (const port of [0, 1023, 65536, 8766.5, '8766/raw-private-setting']) {
    const h = harness({ port, check: async () => assert.fail('不正ポートで接続しない') });
    assert.equal(await runLocal('smoke', h.options), 1);
    assert.deepEqual(h.launched, []);
    assert.deepEqual(h.saved, []);
    assert.deepEqual(h.logs, ['INUI_POC_PORTには1024〜65535の整数を指定してください。']);
    assert.throws(() => serviceEnv({ INUI_POC_PORT: String(port) }), (error) => {
      assert.equal(error.message.includes('raw-private-setting'), false);
      return true;
    });
  }
});
