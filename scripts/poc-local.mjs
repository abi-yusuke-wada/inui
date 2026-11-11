import { spawn } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { listEmployees } from '../apps/poc/src/people.ts';
import { LOCAL_MODEL } from '../packages/core/src/index.ts';
import { probeHttp } from './poc-probe.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SERVICES = ['local-jev', 'app'];
const LABELS = { 'local-jev': '推論サーバー', app: 'アプリ' };
class LocalError extends Error {}
class Stopped extends Error {}

/** 子プロセスには実行環境だけを渡し、認証用の変数は引き継がない。 */
export function serviceEnv(parent = process.env) {
  const env = {};
  for (const key of ['PATH', 'LD_LIBRARY_PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL']) {
    if (typeof parent[key] === 'string') env[key] = parent[key];
  }
  return {
    ...env, NODE_ENV: 'production',
    HF_HOME: `${ROOT}.local-jev/cache`, LOCAL_JEV_MODELS: `${ROOT}.local-jev/models`,
    HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    OMP_NUM_THREADS: '4', MKL_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '4',
  };
}

/** 接続拒否だけを未起動とし、別のサービスや権限エラーを上書きしない。 */
export async function checkService(service, fetchImpl = globalThis.fetch) {
  const url = service === 'app' ? 'http://127.0.0.1:3000/api/employees' : 'http://127.0.0.1:8765/healthz';
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(1500) }); }
  catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return false;
    throw new LocalError(`${LABELS[service]}への接続を確認できません。ポートと実行権限を確認してください。`);
  }
  if (!response.ok) throw new LocalError(`${LABELS[service]}の応答はHTTP ${response.status}です。既存の起動プロセスを確認してください。`);
  let body;
  try { body = await response.json(); }
  catch { throw new LocalError(`${LABELS[service]}の応答を確認できません。`); }
  const valid = service === 'app' ? isDeepStrictEqual(body, { employees: listEmployees() })
    : body?.ok === true && body?.default_model === LOCAL_MODEL;
  if (!valid) throw new LocalError(`${LABELS[service]}のポートには別の設定・サービスが起動しています。`);
  return true;
}

/** PIDは自分が生成した子だけ保持し、そのプロセス群だけを終了する。 */
export function launchService(service) {
  const command = service === 'app' ? process.execPath : `${ROOT}.local-jev/venv/bin/local-jev`;
  const args = service === 'app' ? [`${ROOT}apps/poc/dist/server.js`]
    : ['serve', '--model', LOCAL_MODEL, '--host', '127.0.0.1', '--port', '8765'];
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, { cwd: ROOT, env: serviceEnv(), stdio: 'inherit', detached: grouped });
  let stopping = false;
  let closed = false;
  let onClose;
  const close = new Promise((resolve) => { onClose = resolve; });
  const exited = new Promise((_, reject) => {
    child.once('error', () => {
      closed = true; onClose();
      if (!stopping) reject(new LocalError(`${LABELS[service]}を起動できません。依存の導入とモデルの準備を確認してください。`));
    });
    child.once('close', () => {
      closed = true; onClose();
      if (!stopping) reject(new LocalError(`${LABELS[service]}が終了しました。直前の起動ログを確認してください。`));
    });
  });
  // 起動確認へ到達する前のearly exitも、未処理のrejectにしない。
  void exited.catch(() => {});
  function signal(name) {
    if (closed || !child.pid) return;
    try { grouped ? process.kill(-child.pid, name) : child.kill(name); }
    catch (error) { if (error?.code !== 'ESRCH') throw new LocalError(`${LABELS[service]}を停止できませんでした。`); }
  }
  return {
    exited,
    async stop() {
      stopping = true;
      signal('SIGTERM');
      let timer;
      await Promise.race([close, new Promise((resolve) => { timer = setTimeout(resolve, 4000); })]);
      clearTimeout(timer);
      if (!closed) { signal('SIGKILL'); await close; }
    },
  };
}

async function saveReport(report) {
  await mkdir(`${ROOT}.local-poc`, { recursive: true });
  const path = `${ROOT}.local-poc/http-verification.json`;
  await writeFile(`${path}.tmp`, `${JSON.stringify(report)}\n`);
  await rename(`${path}.tmp`, path);
}

/** 起動済みは再利用し、不足分の起動・検証・自分の子の片付けをまとめる。 */
export async function runLocal(mode, {
  check = checkService, launch = launchService, probe = probeHttp, save = saveReport,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now, log = console.error, timeoutMs = 180_000, installSignals = true,
} = {}) {
  if (!['dev', 'smoke'].includes(mode)) { log('使い方: make app-dev または make app-smoke'); return 1; }
  const owned = [];
  const shutdown = new AbortController();
  let stopped;
  const stopRequested = new Promise((_, reject) => { stopped = () => { shutdown.abort(); reject(new Stopped()); }; });
  void stopRequested.catch(() => {});
  const race = (operation) => Promise.race([operation, stopRequested, ...owned.map((child) => child.exited)]);
  if (installSignals) { process.once('SIGINT', stopped); process.once('SIGTERM', stopped); }
  let code = 0;
  try {
    for (const service of SERVICES) {
      if (await race(check(service))) { log(`${LABELS[service]}: 起動済みを利用します。`); continue; }
      log(`${LABELS[service]}を起動します。`);
      owned.push(launch(service));
      const started = now();
      let lastMessage = started;
      while (!(await race(check(service)))) {
        if (now() - started >= timeoutMs) throw new LocalError(`${LABELS[service]}の起動待ちが時間切れになりました。`);
        if (now() - lastMessage >= 5000) { log(`${LABELS[service]}の起動を待っています…`); lastMessage = now(); }
        await race(sleep(500));
      }
      log(`${LABELS[service]}: 起動しました。`);
    }
    log('自然言語UI: http://127.0.0.1:3000/  比較用UI: http://127.0.0.1:3000/legacy');
    if (mode === 'smoke') {
      const report = await race(probe({ fetchImpl: (url, init) => fetch(url, {
        ...init, signal: init?.signal ? AbortSignal.any([init.signal, shutdown.signal]) : shutdown.signal,
      }) }));
      await save(report);
      code = report.summary.criterion_met ? 0 : 1;
      log(`HTTP確認: ${report.summary.matched}/${report.summary.total}件一致`);
      for (const row of report.results.filter((result) => !result.matched)) {
        log(`${row.sampleID}: ${row.http_status ? `HTTP ${row.http_status}` : row.error ?? `期待=${row.expected}, 実際=${row.actual}`}`);
      }
    } else if (owned.length) {
      log('このターミナルを開いたまま利用してください。終了はCtrl+Cです。');
      await race(new Promise(() => {}));
    }
  } catch (error) {
    code = error instanceof Stopped ? 130 : 1;
    if (!(error instanceof Stopped)) log(error instanceof LocalError ? error.message : 'ローカルPoCの起動・検証を完了できませんでした。');
  } finally {
    shutdown.abort();
    const cleanup = await Promise.allSettled(owned.map((child) => child.stop()));
    if (cleanup.some((result) => result.status === 'rejected')) { log('起動したプロセスの一部を停止できませんでした。'); code = 1; }
    else if (mode === 'smoke' && owned.length) log('検証用に起動したサーバーを停止しました。画面を使うときは make app-dev を実行してください。');
    if (installSignals) { process.removeListener('SIGINT', stopped); process.removeListener('SIGTERM', stopped); }
  }
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  process.exitCode = await runLocal(args.length === 1 && args[0] === '--smoke' ? 'smoke'
    : args.length === 1 && args[0] === '--dev' ? 'dev' : 'invalid');
}
