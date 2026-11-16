import { ApiError, isRecord } from '@inui/feature-kit/web';
import type { Employee, PeopleSelection, ScheduleEvent, ScheduleResult } from './types.ts';

export type { Employee, PeopleSelection, ScheduleEvent, ScheduleResult } from './types.ts';

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const uniqueStrings = (value: unknown): value is string[] =>
  strings(value) && new Set(value).size === value.length;
const validTime = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

/** 判定結果に付いた人名の選択情報を、構造を確認してから受け取る。 */
export function parsePeopleSelection(value: unknown): PeopleSelection {
  if (!isRecord(value) || !uniqueStrings(value.selectedIds) || !strings(value.unknownNames)
      || !Array.isArray(value.ambiguous) || !value.ambiguous.every((item) =>
        isRecord(item) && typeof item.name === 'string' && uniqueStrings(item.candidateIds))) {
    throw new ApiError('invalid');
  }
  return value as unknown as PeopleSelection;
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
