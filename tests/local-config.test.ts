import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appOrigin, appPort, buildId, DEFAULT_APP_PORT } from '../src/local-config.ts';

test('未指定では8766、指定時は検証したポートでloopback URLを作る', () => {
  assert.equal(DEFAULT_APP_PORT, 8766);
  assert.equal(appPort({}), 8766);
  assert.equal(appOrigin(appPort({})), 'http://127.0.0.1:8766');
  assert.equal(appPort({ INUI_POC_PORT: '18766' }), 18766);
  assert.equal(appOrigin(appPort({ INUI_POC_PORT: '18766' })), 'http://127.0.0.1:18766');
  assert.equal(appPort({ INUI_POC_PORT: '1024' }), 1024);
  assert.equal(appPort({ INUI_POC_PORT: '65535' }), 65535);
});

test('範囲外・URL・不正な表記を拒否し、実際の環境値をエラーへ含めない', () => {
  for (const raw of ['', '0', '80', '1023', '65536', '-8766', '8766.0', '8e3', ' 8766', '08766', 'http://external.example', 'private-port-detail', '8765']) {
    assert.throws(() => appPort({ INUI_POC_PORT: raw }), {
      message: 'INUI_POC_PORTは1024〜65535の整数（推論サーバーの8765を除く）で指定してください。',
    });
  }
  for (const port of [NaN, Infinity, 0, 1023, 65536, 8766.5, 8765]) assert.throws(() => appOrigin(port));
});

test('ビルドIDは場所・サーバー・画面の入口とCSS・コアの出力で変わり、同じ場所と内容なら一致する', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'inui-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = join(root, 'core.js');
  writeFileSync(core, 'export const core = 1;');
  /** 同じ内容のビルドを別の場所に作る（同じリビジョンの別のworktreeを想定）。 */
  const dist = (name: string) => {
    const directory = join(root, name, 'dist');
    mkdirSync(join(directory, 'public'), { recursive: true });
    for (const [file, content] of [['server.js', 'server'], ['public/app.js', 'app'], ['public/app.css', 'css']] as const) {
      writeFileSync(join(directory, file), content);
    }
    return pathToFileURL(directory + '/');
  };
  const first = dist('first');
  const coreUrl = pathToFileURL(core);
  const original = await buildId(first, coreUrl);
  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(await buildId(first, coreUrl), original);
  assert.notEqual(await buildId(dist('second'), coreUrl), original);
  writeFileSync(new URL('public/app.css', first), 'css changed');
  const cssChanged = await buildId(first, coreUrl);
  assert.notEqual(cssChanged, original);
  writeFileSync(core, 'export const core = 2;');
  assert.notEqual(await buildId(first, coreUrl), cssChanged);
});
