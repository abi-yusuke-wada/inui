import type { Application, Employee, PeopleSelection, ScheduleEvent } from '../types.ts';

export type Screen = 'leave_request' | 'expense_request' | 'application_status' | 'schedule_compare';
export type Notice = 'unsupported_feature' | 'unsupported_operation' | 'clarify';
export type Decision =
  | { kind: 'screen'; intent: Screen; ui: Screen; people?: PeopleSelection }
  | { kind: 'notice'; intent: Notice; message: string };
export type ScheduleResult = { date: string; employees: Employee[]; events: ScheduleEvent[] };

/** 外部の応答本文や例外を画面へ渡さず、失敗の種類だけを保持する。 */
export class ApiError extends Error {
  kind: 'http' | 'network' | 'invalid' | 'timeout' | 'aborted';
  status: number | undefined;
  constructor(kind: ApiError['kind'], status?: number) {
    super('操作を完了できませんでした。');
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

/** 次の要求や画面の破棄後に、以前の応答を反映しないための境界。 */
export class LatestRequest {
  private controller: AbortController | undefined;
  begin() {
    this.cancel();
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      isCurrent: () => this.controller === controller && !controller.signal.aborted,
    };
  }
  cancel() {
    this.controller?.abort();
    this.controller = undefined;
  }
}

/** 同一オリジンのAPIを呼び、エラー本文を表示用の情報に使わない。 */
export async function fetchJson(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    body?: unknown;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 30_000);
  try {
    if (controller.signal.aborted) throw new ApiError('aborted');
    let response: Response;
    try {
      response = await (options.fetchImpl ?? globalThis.fetch)(url, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        ...(options.body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options.body),
        }),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'network');
    }
    if (!response.ok) throw new ApiError('http', response.status);
    try {
      return await response.json();
    } catch {
      throw new ApiError(timedOut ? 'timeout' : 'invalid');
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const uniqueStrings = (value: unknown): value is string[] =>
  strings(value) && new Set(value).size === value.length;

/** 日付入力の実在を、タイムゾーンによる日付の変換なしで調べる。 */
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const validTime = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const screens: Screen[] = ['leave_request', 'expense_request', 'application_status', 'schedule_compare'];
const notices: Notice[] = ['unsupported_feature', 'unsupported_operation', 'clarify'];

/** 許可した画面だけを開き、人名の選択情報も構造を確認して受け取る。 */
export function parseDecision(value: unknown): Decision {
  if (!isRecord(value)) throw new ApiError('invalid');
  if (value.kind === 'screen' && screens.includes(value.intent as Screen) && value.ui === value.intent) {
    let people: PeopleSelection | undefined;
    if (value.people !== undefined) {
      const p = value.people;
      if (!isRecord(p) || !uniqueStrings(p.selectedIds) || !strings(p.unknownNames)
          || !Array.isArray(p.ambiguous) || !p.ambiguous.every((item) =>
            isRecord(item) && typeof item.name === 'string' && uniqueStrings(item.candidateIds))) {
        throw new ApiError('invalid');
      }
      people = p as unknown as PeopleSelection;
    }
    return { kind: 'screen', intent: value.intent as Screen, ui: value.intent as Screen, ...(people ? { people } : {}) };
  }
  if (value.kind === 'notice' && notices.includes(value.intent as Notice) && typeof value.message === 'string') {
    return { kind: 'notice', intent: value.intent as Notice, message: value.message };
  }
  throw new ApiError('invalid');
}

function isApplication(value: unknown): value is Application {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
      || !validDate(value.submittedOn) || !validDate(value.date)
      || !['pending', 'approved', 'returned'].includes(value.status as string)) return false;
  if (value.type === 'leave') {
    return ['full_day', 'am', 'pm'].includes(value.period as string)
      && (value.reason === undefined || typeof value.reason === 'string');
  }
  return value.type === 'expense' && typeof value.amount === 'number'
    && Number.isSafeInteger(value.amount) && value.amount >= 1
    && (value.description === undefined || typeof value.description === 'string');
}

export function parseApplications(value: unknown): Application[] {
  if (!isRecord(value) || !Array.isArray(value.applications) || !value.applications.every(isApplication)) {
    throw new ApiError('invalid');
  }
  return value.applications;
}

export function parseSavedApplication(value: unknown): Application {
  if (!isRecord(value) || !isApplication(value.application)) throw new ApiError('invalid');
  return value.application;
}

export function parseEmployees(value: unknown): Employee[] {
  if (!isRecord(value) || !Array.isArray(value.employees)
      || !value.employees.every((item) => isRecord(item) && typeof item.id === 'string'
        && item.id.length > 0 && typeof item.name === 'string' && item.name.length > 0)) {
    throw new ApiError('invalid');
  }
  const employees = value.employees as Employee[];
  if (new Set(employees.map((item) => item.id)).size !== employees.length) throw new ApiError('invalid');
  return employees;
}

/** 要求していない人や日付の予定を、現在の検索結果として表示しない。 */
export function parseSchedules(value: unknown, date: string, selectedIds: string[]): ScheduleResult {
  if (!isRecord(value) || value.date !== date || !Array.isArray(value.events)) throw new ApiError('invalid');
  const employees = parseEmployees(value);
  if (employees.length !== selectedIds.length || employees.some((employee) => !selectedIds.includes(employee.id))
      || !value.events.every((event) => isRecord(event) && typeof event.id === 'string'
        && typeof event.personId === 'string' && selectedIds.includes(event.personId)
        && typeof event.title === 'string' && validTime(event.start) && validTime(event.end)
        && event.start < event.end)) throw new ApiError('invalid');
  return { date, employees, events: value.events as ScheduleEvent[] };
}

export function errorMessage(error: unknown, action: string): string {
  if (error instanceof ApiError && error.status === 400) return '入力内容を確認して、もう一度お試しください。';
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    return 'この操作を利用できません。ページを再読み込みしてお試しください。';
  }
  if (error instanceof ApiError && error.kind === 'timeout') return action + 'に時間がかかっています。時間をおいてお試しください。';
  return action + 'ができませんでした。接続を確認して、もう一度お試しください。';
}
