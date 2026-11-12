import assert from 'node:assert/strict';
import test from 'node:test';
import { appOrigin, appPort, DEFAULT_APP_PORT } from '../src/local-config.ts';

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
  for (const raw of ['', '0', '80', '1023', '65536', '-8766', '8766.0', '8e3', ' 8766', '08766', 'http://external.example', 'private-port-detail']) {
    assert.throws(() => appPort({ INUI_POC_PORT: raw }), {
      message: 'INUI_POC_PORTは1024〜65535の整数で指定してください。',
    });
  }
  for (const port of [NaN, Infinity, 0, 1023, 65536, 8766.5]) assert.throws(() => appOrigin(port));
});
