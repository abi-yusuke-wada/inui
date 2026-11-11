import type { Employee, PeopleSelection, ScheduleEvent } from './types.ts';

export const DEFAULT_DATE = '2026-11-02';
const PEOPLE = [
  { id: 'person-yamada-taro', name: '山田太郎', surname: '山田' },
  { id: 'person-sato-hanako', name: '佐藤花子', surname: '佐藤' },
  { id: 'person-suzuki-ichiro', name: '鈴木一郎', surname: '鈴木' },
  { id: 'person-yamada-hanako', name: '山田花子', surname: '山田' },
] as const;

/** 社員辞書を返し、呼び出し側から内部データを変更させない。 */
export function listEmployees(): Employee[] {
  return PEOPLE.map(({ id, name }) => ({ id, name }));
}

/** 全名を優先し、同姓や辞書にない名前は選択済みにしない。 */
export function selectPeople(text: string): PeopleSelection {
  let remaining = text.normalize('NFKC').replace(/\s/gu, '');
  const selected = new Set<string>();
  const ambiguous = new Map<string, string[]>();
  const unknown = new Set<string>();
  const surnames = [...new Set(PEOPLE.map((person) => person.surname))];
  const knownName = (name: string): boolean => PEOPLE.some((person) => person.name === name || person.surname === name);
  const selectName = (name: string): boolean => {
    const exact = PEOPLE.find((person) => person.name === name);
    if (exact) { selected.add(exact.id); return true; }
    const candidates = PEOPLE.filter((person) => person.surname === name);
    if (candidates.length === 1) selected.add(candidates[0]!.id);
    else if (candidates.length > 1) ambiguous.set(name, candidates.map((person) => person.id));
    return candidates.length > 0;
  };
  // 「さん」を越えず混在文字の名前全体を除き、未知名の残姓を選ばない。
  remaining = remaining.replace(
    /((?:(?!さん)[\p{L}々ー])+)さん/gu,
    (mention: string, raw: string, offset: number) => {
      // 前の「さん」に続く説明を分ける。「予定さん」という未知名は残す。
      let name = offset > 0
        ? raw.replace(/^の(?:予定|スケジュール)(?:と|や)/u, '').replace(/^[とや]+/u, '')
        : raw;
      name = name.replace(/^.*の(?=[\p{Script=Han}\p{Script=Katakana}A-Za-z])/u, '');
      const parts = name.split(/[とや]/u).filter(Boolean);
      // 「山田太郎と田中さん」のような列挙だけを分ける。不確かな仮名名は一名として残す。
      const separate = parts.length > 1 && parts.some(knownName)
        && parts.every((part) => knownName(part) || /^[\p{Script=Han}\p{Script=Katakana}A-Za-z]/u.test(part));
      for (const candidate of separate ? parts : [name]) {
        if (!selectName(candidate)) unknown.add(candidate);
      }
      return ' '.repeat(mention.length);
    },
  );
  const beforeName = (index: number): boolean => index === 0
    || /[\s\p{P}\p{S}とやの]/u.test(remaining[index - 1]!);
  const afterName = (index: number): boolean =>
    /^(?:$|[\s\p{P}\p{S}]|[とや](?=[\s\p{Script=Han}\p{Script=Katakana}A-Za-z])|の(?:予定|スケジュール|空き|都合))/u.test(remaining.slice(index));
  for (const person of PEOPLE) {
    remaining = remaining.replaceAll(person.name, (match, index: number) => {
      if (!beforeName(index) || !afterName(index + match.length)) return match;
      selected.add(person.id);
      return ' '.repeat(match.length);
    });
  }
  for (const name of surnames) {
    for (const match of remaining.matchAll(new RegExp(name, 'gu'))) {
      if (!beforeName(match.index)) continue;
      if (afterName(match.index + name.length)) selectName(name);
      else {
        // 敬称なしの未知名も、既知の姓だけを切り出して選ばない。
        const candidate = remaining.slice(match.index).match(
          /^(?:(?![とや](?=[\s\p{Script=Han}\p{Script=Katakana}A-Za-z])|の(?:予定|スケジュール|空き|都合))[\p{L}々ー])+/u,
        )?.[0];
        if (candidate) unknown.add(candidate);
      }
    }
  }
  return {
    selectedIds: PEOPLE.filter((person) => selected.has(person.id)).map((person) => person.id),
    ambiguous: [...ambiguous].map(([name, candidateIds]) => ({ name, candidateIds })),
    unknownNames: [...unknown],
  };
}

const SCHEDULES: Record<string, readonly ScheduleEvent[]> = {
  '2026-11-02': [
    { id: 'nov2-yamada-1', personId: 'person-yamada-taro', title: '朝会', start: '09:00', end: '09:30' },
    { id: 'nov2-yamada-2', personId: 'person-yamada-taro', title: '設計レビュー', start: '13:00', end: '14:00' },
    { id: 'nov2-sato-1', personId: 'person-sato-hanako', title: '顧客打ち合わせ', start: '10:00', end: '11:00' },
    { id: 'nov2-sato-2', personId: 'person-sato-hanako', title: '設計レビュー', start: '13:00', end: '14:00' },
    { id: 'nov2-suzuki-1', personId: 'person-suzuki-ichiro', title: '作業時間', start: '09:30', end: '11:30' },
    { id: 'nov2-hanako-1', personId: 'person-yamada-hanako', title: '部内ミーティング', start: '14:00', end: '15:00' },
  ],
  '2026-11-03': [
    { id: 'nov3-yamada-1', personId: 'person-yamada-taro', title: '作業時間', start: '10:00', end: '11:00' },
    { id: 'nov3-sato-1', personId: 'person-sato-hanako', title: '相談会', start: '14:00', end: '15:00' },
    { id: 'nov3-suzuki-1', personId: 'person-suzuki-ichiro', title: 'レビュー', start: '11:00', end: '12:00' },
    { id: 'nov3-hanako-1', personId: 'person-yamada-hanako', title: '相談会', start: '14:00', end: '15:00' },
  ],
};

/** 指定した日と社員の予定だけを返し、空の選択を全員へ広げない。 */
export function listSchedules(date: string, personIds: readonly string[]) {
  const selected = new Set(personIds);
  return {
    date,
    employees: listEmployees().filter((person) => selected.has(person.id)),
    events: (SCHEDULES[date] ?? []).filter((event) => selected.has(event.personId)).map((event) => ({ ...event })),
  };
}
