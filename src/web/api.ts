import { ApiError, errorMessage as kitErrorMessage, isRecord } from '@inui/feature-kit/web';
import { parsePeopleSelection } from '@inui/feature-schedule/client';
import type { PeopleSelection } from '@inui/feature-schedule/client';

export { ApiError, LatestRequest, fetchJson, validDate } from '@inui/feature-kit/web';

/** 業務画面と共通の案内に、判定（画面の表示）だけの入力エラーの案内を加える。 */
export function errorMessage(error: unknown, action: string): string {
  // 判定の入力エラーには、推論サーバーでの切り詰めも含まれるため、短くしての再試行を案内する。
  if (error instanceof ApiError && error.status === 400 && action === '画面の表示') {
    return '入力が長すぎるか、内容を判定できませんでした。入力を短くして、もう一度お試しください。';
  }
  return kitErrorMessage(error, action);
}

export type Screen = 'markdown_view' | 'task_board' | 'schedule_compare';
export type Notice = 'unsupported_feature' | 'unsupported_operation' | 'clarify';
export type Decision =
  | { kind: 'screen'; intent: Screen; ui: Screen; people?: PeopleSelection }
  | { kind: 'notice'; intent: Notice; message: string };

export const SCREENS: readonly Screen[] = ['markdown_view', 'task_board', 'schedule_compare'];
const NOTICES: readonly Notice[] = ['unsupported_feature', 'unsupported_operation', 'clarify'];

/** 許可した画面だけを開き、人名の選択情報は予定比較のときだけ構造を確認して受け取る。 */
export function parseDecision(value: unknown): Decision {
  if (!isRecord(value)) throw new ApiError('invalid');
  if (value.kind === 'screen' && SCREENS.includes(value.intent as Screen) && value.ui === value.intent) {
    const screen = value.intent as Screen;
    if (value.people !== undefined && screen !== 'schedule_compare') throw new ApiError('invalid');
    const people = value.people === undefined ? undefined : parsePeopleSelection(value.people);
    return { kind: 'screen', intent: screen, ui: screen, ...(people ? { people } : {}) };
  }
  if (value.kind === 'notice' && NOTICES.includes(value.intent as Notice) && typeof value.message === 'string') {
    return { kind: 'notice', intent: value.intent as Notice, message: value.message };
  }
  throw new ApiError('invalid');
}
