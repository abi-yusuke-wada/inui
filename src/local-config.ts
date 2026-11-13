export const DEFAULT_APP_PORT = 8766;
/** 内部推論サーバー（local-jev）が使うため、アプリには割り当てない。 */
export const RESERVED_NLI_PORT = 8765;
const PORT_ERROR = 'INUI_POC_PORTは1024〜65535の整数（推論サーバーの8765を除く）で指定してください。';

function checkedPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === RESERVED_NLI_PORT) throw new Error(PORT_ERROR);
  return port;
}

/** ローカル検証用のポートだけを変更可能にし、入力値をエラーへ含めない。 */
export function appPort(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.INUI_POC_PORT;
  if (raw === undefined) return DEFAULT_APP_PORT;
  if (!/^[1-9][0-9]{3,4}$/.test(raw)) throw new Error(PORT_ERROR);
  return checkedPort(Number(raw));
}

/** 接続先のホストは環境変数で変更せず、IPv4 loopbackに固定する。 */
export function appOrigin(port = appPort()): string {
  return `http://127.0.0.1:${checkedPort(port)}`;
}
