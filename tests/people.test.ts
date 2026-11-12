import assert from 'node:assert/strict';
import test from 'node:test';
import { listEmployees, listSchedules, selectPeople } from '../src/people.ts';

test('全名を優先し、同姓の別社員を自動追加しない', () => {
  assert.deepEqual(selectPeople('山田 太郎と佐藤花子の予定を比べたい'), {
    selectedIds: ['person-yamada-taro', 'person-sato-hanako'], ambiguous: [], unknownNames: [],
  });
  assert.deepEqual(selectPeople('山田花子さんと鈴木さん'), {
    selectedIds: ['person-suzuki-ichiro', 'person-yamada-hanako'], ambiguous: [], unknownNames: [],
  });
});

test('同姓・未知名は候補として残し、同じ人の繰り返しを重複させない', () => {
  assert.deepEqual(selectPeople('山田さんと田中さんと佐藤さんと佐藤さんと田中さん'), {
    selectedIds: ['person-sato-hanako'],
    ambiguous: [{ name: '山田', candidateIds: ['person-yamada-taro', 'person-yamada-hanako'] }],
    unknownNames: ['田中'],
  });
  assert.deepEqual(selectPeople('山田太郎と山田の予定'), {
    selectedIds: ['person-yamada-taro'],
    ambiguous: [{ name: '山田', candidateIds: ['person-yamada-taro', 'person-yamada-hanako'] }], unknownNames: [],
  });
});

test('未知名の一部を既知社員として選択せず、名前なしを全員へ広げない', () => {
  assert.deepEqual(selectPeople('山田川さんと山田太郎丸さん'), {
    selectedIds: [], ambiguous: [], unknownNames: ['山田川', '山田太郎丸'],
  });
  assert.deepEqual(selectPeople('複数人の予定を確認したい'), { selectedIds: [], ambiguous: [], unknownNames: [] });
});

test('漢字と仮名・英字の混在した未知名を残姓から選択しない', () => {
  for (const name of ['佐藤アキラ', '佐藤あきら', '佐藤Akira', '佐藤のりこ', '佐藤としこ', '佐藤' + 'ア'.repeat(100)]) {
    assert.deepEqual(selectPeople(`${name}さんの予定`), {
      selectedIds: [], ambiguous: [], unknownNames: [name],
    });
  }
  assert.deepEqual(selectPeople('山田太郎さんと佐藤花子さんの予定'), {
    selectedIds: ['person-yamada-taro', 'person-sato-hanako'], ambiguous: [], unknownNames: [],
  });
  assert.deepEqual(selectPeople('明日の山田さんと佐藤花子と田中さんの予定'), {
    selectedIds: ['person-sato-hanako'],
    ambiguous: [{ name: '山田', candidateIds: ['person-yamada-taro', 'person-yamada-hanako'] }],
    unknownNames: ['田中'],
  });
});

test('敬称なしの未知名を既知姓・全名の部分一致から選択しない', () => {
  for (const name of ['佐藤川', '佐藤あきら', '佐藤アキラ', '佐藤のりこ', '佐藤としこ', '山田太郎丸']) {
    assert.deepEqual(selectPeople(`${name}と鈴木の予定を見たい`), {
      selectedIds: ['person-suzuki-ichiro'], ambiguous: [], unknownNames: [name],
    });
  }
  assert.deepEqual(selectPeople('山田太郎と佐藤花子の予定を見たい'), {
    selectedIds: ['person-yamada-taro', 'person-sato-hanako'], ambiguous: [], unknownNames: [],
  });
  // 「を比較」の直前の全名も選択する。
  assert.deepEqual(selectPeople('山田太郎と佐藤花子を比較したい'), {
    selectedIds: ['person-yamada-taro', 'person-sato-hanako'], ambiguous: [], unknownNames: [],
  });
  assert.deepEqual(selectPeople('佐藤川を比較したい').unknownNames, ['佐藤川']);
  assert.deepEqual(selectPeople('佐藤川と鈴木と山田太郎の予定を見たい'), {
    selectedIds: ['person-yamada-taro', 'person-suzuki-ichiro'], ambiguous: [], unknownNames: ['佐藤川'],
  });
});

test('前の社員に続く予定の説明を未知名へ混ぜず、予定さんという未知名は残す', () => {
  for (const text of [
    '佐藤さんの予定と鈴木さんの予定を比較したい',
    '佐藤さんのスケジュールと鈴木さんのスケジュールを比較したい',
    '佐藤さんの予定や鈴木さんの予定を見たい',
  ]) {
    assert.deepEqual(selectPeople(text), {
      selectedIds: ['person-sato-hanako', 'person-suzuki-ichiro'], ambiguous: [], unknownNames: [],
    });
  }
  for (const text of ['予定さん', '佐藤さんと予定さん', '佐藤さんの予定と予定さん']) {
    assert.deepEqual(selectPeople(text).unknownNames, ['予定']);
  }
  assert.deepEqual(selectPeople('佐藤さんのスケジュールと山田さんの予定'), {
    selectedIds: ['person-sato-hanako'],
    ambiguous: [{ name: '山田', candidateIds: ['person-yamada-taro', 'person-yamada-hanako'] }], unknownNames: [],
  });
});

test('予定は明示した日・社員に限定し、戻り値の変更を内部データへ伝えない', () => {
  const result = listSchedules('2026-11-02', ['person-yamada-taro', 'person-sato-hanako']);
  assert.equal(result.employees.length, 2);
  assert.ok(result.events.length > 0);
  assert.ok(result.events.every((event) => result.employees.some((person) => person.id === event.personId)));
  const employee = result.employees[0];
  const event = result.events[0];
  assert.ok(employee);
  assert.ok(event);
  employee.name = '変更';
  event.title = '変更';
  const originalEmployee = listEmployees()[0];
  const originalEvent = listSchedules('2026-11-02', ['person-yamada-taro']).events[0];
  assert.ok(originalEmployee);
  assert.ok(originalEvent);
  assert.notEqual(originalEmployee.name, '変更');
  assert.notEqual(originalEvent.title, '変更');
  assert.deepEqual(listSchedules('2026-11-02', []).events, []);
  assert.deepEqual(listSchedules('2026-11-04', ['person-yamada-taro']).events, []);
});
