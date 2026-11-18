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

/** 「今日の予定と」等の説明に使う語。人名の候補にしない。 */
const NOT_NAMES = new Set(['今日', '明日', '昨日', '明後日', '本日', '今週', '来週', '先週', '今月', '来月', '午前', '午後', '全員', '複数人', 'チーム', '部署', '自分']);

/** 全名を優先し、同姓や辞書にない名前は選択済みにしない。 */
export function selectPeople(text: string): PeopleSelection {
  let remaining = text.normalize('NFKC').replace(/\s/gu, '');
  const normalized = remaining;
  const selected = new Set<string>();
  const ambiguous = new Map<string, string[]>();
  const unknown = new Set<string>();
  const surnames = [...new Set(PEOPLE.map((person) => person.surname))];
  const knownName = (name: string): boolean => PEOPLE.some((person) => person.name === name || person.surname === name);
  const selectName = (name: string): boolean => {
    const exact = PEOPLE.find((person) => person.name === name);
    if (exact) { selected.add(exact.id); return true; }
    const candidates = PEOPLE.filter((person) => person.surname === name);
    const candidate = candidates[0];
    if (candidates.length === 1 && candidate) selected.add(candidate.id);
    else if (candidates.length > 1) ambiguous.set(name, candidates.map((person) => person.id));
    return candidates.length > 0;
  };
  // 「さん」を越えず混在文字の名前全体を除き、未知名の残姓を選ばない。
  remaining = remaining.replace(
    /((?:(?!さん)[\p{L}々ー])+)さん/gu,
    (mention: string, raw: string, offset: number) => {
      // 前の「さん」に続く説明を分ける。「予定さん」という未知名は残す。
      let name = offset > 0
        ? raw.replace(/^の(?:予定|スケジュール|空き|都合)(?:と|や)/u, '').replace(/^[とや]+/u, '')
        : raw;
      // 「山田太郎の予定と佐藤花子さん」のように、敬称なしの名前と説明が先に続く場合は分けてから扱う。
      // 前の部分は既知の名前（全名・姓）のときだけ選び、「今日の予定と」等の説明は名前にしない。
      const leading = name.match(/^(.+?)の(?:予定|スケジュール|空き|都合)(?:と|や)(.+)$/u);
      if (leading?.[1] && leading[2]) {
        const head = leading[1].replace(/^.*(?:の|は|が|も|で|に|を)(?=[\p{Script=Han}\p{Script=Katakana}A-Za-z])/u, '');
        if (knownName(head)) selectName(head);
        // 「田中の予定と」の田中のように辞書にない名前は、確認の対象として残す。
        else if (/^[\p{Script=Han}\p{Script=Katakana}A-Za-z]/u.test(head) && !NOT_NAMES.has(head)) unknown.add(head);
        name = leading[2];
      }
      // 「今日は山田太郎さん」の「今日は」のような前置きを、助詞までまとめて名前から外す。
      name = name.replace(/^.*(?:の|は|が|も|で|に|を)(?=[\p{Script=Han}\p{Script=Katakana}A-Za-z])/u, '');
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
    // 「今日は山田太郎と…」のように、助詞の直後も名前の始まりとして扱う。
    || /[\s\p{P}\p{S}とやのはがもでにを]/u.test(remaining.charAt(index - 1));
  const afterName = (index: number): boolean =>
    /^(?:$|[\s\p{P}\p{S}]|[とや](?=[\s\p{Script=Han}\p{Script=Katakana}A-Za-z])|の(?:予定|スケジュール|空き|都合)|を(?:比較|比べ|見比べ))/u.test(remaining.slice(index));
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
          /^(?:(?![とや](?=[\s\p{Script=Han}\p{Script=Katakana}A-Za-z])|の(?:予定|スケジュール|空き|都合)|を(?:比較|比べ|見比べ))[\p{L}々ー])+/u,
        )?.[0];
        if (candidate) unknown.add(candidate);
      }
    }
  }
  // 「山田太郎と佐藤花子と田中を比較」のように敬称なしで並べた中の未知名も、確認の対象に残す。
  // 既知の名前を1つ以上含む列挙だけを対象にし、「複数人の予定」等の一般語は未知名にしない。
  // 語の途中から切り出さないよう、直前が漢字・カタカナ・英字でない位置からだけ始める。
  // 名前の先頭は漢字・カタカナ・英字とし、2文字目以降は「田中あきら」のようにひらがなも含める。
  // 区切りや説明に使う「と・や・の・を」と敬称の「さん」は名前に含めない。
  const token = '[\\p{Script=Han}\\p{Script=Katakana}A-Za-z々ー](?:(?!さん|[とやのを])[\\p{L}々ー])*';
  const enumeration = new RegExp(
    `(?<![\\p{Script=Han}\\p{Script=Katakana}A-Za-z々ー])(?:${token}[とや])+${token}(?=を(?:比較|比べ|見比べ)|の(?:予定|スケジュール|空き|都合)|$)`, 'gu');
  // 「山田太郎の予定と佐藤花子の予定」の「予定」のような説明語は、名前の候補にしない。
  const descriptions = new Set(['予定', 'スケジュール', '空き', '都合']);
  for (const [match] of normalized.matchAll(enumeration)) {
    // 「今日は山田太郎と…」の「今日は」のような前置きは、助詞までまとめて外す。
    const parts = match.split(/[とや]/u)
      .map((part) => part.replace(/^.*(?:の|は|が|も|で|に|を)(?=[\p{Script=Han}\p{Script=Katakana}A-Za-z])/u, ''))
      .filter((part) => part && !descriptions.has(part));
    if (!parts.some(knownName)) continue;
    for (const part of parts) if (!knownName(part)) unknown.add(part);
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
