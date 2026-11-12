import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';
import type { Application, Employee } from '../../src/types.ts';

const employees: Employee[] = [
  { id: 'yamada-taro', name: '山田太郎' },
  { id: 'sato-hanako', name: '佐藤花子' },
  { id: 'suzuki-ichiro', name: '鈴木一郎' },
  { id: 'yamada-hanako', name: '山田花子' },
];
const initialApplications: Application[] = [
  { id: 'leave-1', type: 'leave', submittedOn: '2026-10-27', date: '2026-10-30', period: 'full_day', status: 'approved' },
  { id: 'expense-1', type: 'expense', submittedOn: '2026-10-29', date: '2026-10-28', amount: 880, description: '交通費', status: 'pending' },
];

/** APIだけをモックするDOM操作テスト。実ブラウザやNLIの精度測定ではない。 */
test('PoCの4つの利用経路をJSDOMで操作する（実ブラウザではない）', { concurrency: false }, async (suite) => {
  const dom = new JSDOM('<!doctype html><html lang="ja"><body></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true,
  });
  const replacements: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: globalThis.fetch,
  };
  const descriptors = new Map(Object.keys(replacements).map((key) =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const));
  let activeRoot: Root | undefined;
  let act: typeof import('react')['act'] | undefined;
  try {
    for (const [key, value] of Object.entries(replacements)) {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    // ReactDOMのDOM対応判定は、上記のグローバルを設定した後で初期化する。
    const react = await import('react');
    act = react.act;
    const { createRoot } = await import('react-dom/client');
    const { App } = await import('../../src/web/App.tsx');
    const document = dom.window.document;
    const response = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const visibleText = (element: Element) => {
      const copy = element.cloneNode(true) as Element;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((node) => { node.remove(); });
      return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
    };
    const button = (name: string) => {
      const result = [...document.querySelectorAll('button')].find((node) => visibleText(node) === name);
      assert.ok(result, 'ボタンが見つかりません: ' + name);
      return result;
    };
    const field = (name: string) => {
      const label = [...document.querySelectorAll('label')].find((node) => visibleText(node).startsWith(name));
      assert.ok(label, 'ラベルが見つかりません: ' + name);
      const result = label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input');
      assert.ok(result instanceof dom.window.HTMLInputElement
        || result instanceof dom.window.HTMLTextAreaElement || result instanceof dom.window.HTMLSelectElement);
      return result;
    };
    const change = async (name: string, value: string) => {
      const control = field(name);
      const prototype = control instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype
        : control instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      assert.ok(setter);
      await react.act(async () => {
        setter.call(control, value);
        control.dispatchEvent(new dom.window.Event(control instanceof dom.window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      });
    };
    const click = async (name: string) => {
      const target = button(name);
      assert.equal(target.disabled, false, 'ボタンが無効です: ' + name);
      await react.act(async () => target.click());
    };
    const heading = (name: string) => [...document.querySelectorAll('h1,h2,h3,h4')].some((node) => visibleText(node) === name);
    const waitFor = async (condition: () => boolean, message: string) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (condition()) return;
        await react.act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      }
      assert.ok(condition(), message + '\n表示: ' + document.body.textContent);
    };
    const checkedNames = () => [...document.querySelectorAll('label')].filter((label) =>
      label.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).map(visibleText);
    const withApp = async (pathname: string, fetchImpl: typeof fetch, work: () => Promise<void>) => {
      dom.window.history.replaceState(null, '', pathname);
      Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fetchImpl });
      const container = document.createElement('div');
      document.body.replaceChildren(container);
      activeRoot = createRoot(container);
      try {
        await react.act(async () => activeRoot?.render(react.createElement(App)));
        await work();
      } finally {
        await react.act(async () => activeRoot?.unmount());
        activeRoot = undefined;
        container.remove();
      }
    };

    await suite.test('自然文から交通費フォームを開き、空欄へ入力して1回だけ保存し一覧で確認する', async () => {
      let saveCalls = 0;
      let resolveSave: ((value: Response) => void) | undefined;
      let savedBody: unknown;
      const saved: Application = { id: 'expense-2', type: 'expense', submittedOn: '2026-11-02', date: '2026-11-01', amount: 1200, description: '電車代', status: 'pending' };
      const fetchImpl: typeof fetch = async (input, options) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/intent') {
          assert.equal(options?.method, 'POST');
          return response({ kind: 'screen', intent: 'expense_request', ui: 'expense_request' });
        }
        if (url.pathname === '/api/applications/expense') {
          saveCalls++;
          savedBody = JSON.parse(String(options?.body));
          return await new Promise<Response>((resolve, reject) => {
            resolveSave = resolve;
            options?.signal?.addEventListener('abort', () => reject(new Error('mock abort')), { once: true });
          });
        }
        if (url.pathname === '/api/applications') return response({ applications: [...initialApplications, saved] });
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      await withApp('/', fetchImpl, async () => {
        assert.equal(document.querySelector('nav[aria-label="業務メニュー"]'), null);
        await change('したいこと', '昨日の交通費1,200円を精算したい');
        await click('画面を開く');
        await waitFor(() => heading('交通費精算'), '交通費精算フォームが開きませんでした。');
        assert.equal(field('利用日').value, '');
        assert.equal(field('金額').value, '');
        await change('利用日', '2026-11-01');
        await change('金額', '1200');
        await change('内容', '電車代');
        const form = field('利用日').closest('form');
        assert.ok(form);
        await react.act(async () => {
          form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
          form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        });
        assert.equal(saveCalls, 1);
        assert.equal(button('保存しています…').disabled, true);
        assert.deepEqual(savedBody, { date: '2026-11-01', amount: 1200, description: '電車代' });
        assert.ok(resolveSave);
        await react.act(async () => resolveSave?.(response({ application: saved }, 201)));
        await waitFor(() => heading('申請一覧') && document.body.textContent?.includes('1,200円') === true, '保存結果が一覧に表示されませんでした。');
        assert.match(document.body.textContent ?? '', /受け付けました/);
        assert.equal(saveCalls, 1);
      });
    });

    await suite.test('社員名付きの予定比較は2人だけ事前選択し、固定日を自動取得して並列表示する', async () => {
      const selections: { date: string | null; ids: string[] }[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/intent') return response({ kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare',
          people: { selectedIds: ['yamada-taro', 'sato-hanako'], ambiguous: [], unknownNames: [] } });
        if (url.pathname === '/api/employees') return response({ employees });
        if (url.pathname === '/api/schedules') {
          selections.push({ date: url.searchParams.get('date'), ids: (url.searchParams.get('personIds') ?? '').split(',') });
          return response({ date: '2026-11-02', employees: employees.slice(0, 2),
            events: [{ id: 'event-1', personId: 'yamada-taro', title: 'チーム打合せ', start: '10:00', end: '11:00' }] });
        }
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      await withApp('/', fetchImpl, async () => {
        await change('したいこと', '明日の山田太郎さんと佐藤花子さんの予定を比較したい');
        await click('画面を開く');
        await waitFor(() => heading('2026/11/02の予定'), '予定が自動表示されませんでした。');
        assert.deepEqual(checkedNames(), ['山田太郎', '佐藤花子']);
        assert.equal(field('予定日').value, '2026-11-02');
        assert.deepEqual(selections, [{ date: '2026-11-02', ids: ['yamada-taro', 'sato-hanako'] }]);
        const yamada = document.querySelector('section[aria-label="山田太郎の予定"]');
        const sato = document.querySelector('section[aria-label="佐藤花子の予定"]');
        assert.ok(yamada && sato);
        assert.match(yamada.textContent ?? '', /10:00.*11:00.*チーム打合せ/);
        assert.match(sato.textContent ?? '', /この日の予定はありません/);
        assert.equal(document.querySelector('section[aria-label="鈴木一郎の予定"]'), null);
      });
    });

    await suite.test('同姓と未知の名前を勝手に補充せず、手動で2人選んでから取得する', async () => {
      const selections: string[][] = [];
      const fetchImpl: typeof fetch = async (input) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/intent') return response({ kind: 'screen', intent: 'schedule_compare', ui: 'schedule_compare',
          people: { selectedIds: [], ambiguous: [{ name: '山田', candidateIds: ['yamada-taro', 'yamada-hanako'] }], unknownNames: ['田中'] } });
        if (url.pathname === '/api/employees') return response({ employees });
        if (url.pathname === '/api/schedules') {
          const ids = (url.searchParams.get('personIds') ?? '').split(',');
          selections.push(ids);
          return response({ date: '2026-11-02', employees: employees.filter((employee) => ids.includes(employee.id)), events: [] });
        }
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      await withApp('/', fetchImpl, async () => {
        await change('したいこと', '山田さんと田中さんの予定を比較したい');
        await click('画面を開く');
        await waitFor(() => document.querySelectorAll('input[type="checkbox"]').length === 4, '社員を選択できませんでした。');
        assert.deepEqual(checkedNames(), []);
        assert.equal(selections.length, 0);
        assert.match(document.body.textContent ?? '', /複数います/);
        assert.match(document.body.textContent ?? '', /田中/);
        await react.act(async () => (field('山田太郎') as HTMLInputElement).click());
        await react.act(async () => (field('鈴木一郎') as HTMLInputElement).click());
        assert.equal(selections.length, 0);
        await click('予定を表示');
        await waitFor(() => heading('2026/11/02の予定'), '手動選択後の予定が表示されませんでした。');
        assert.deepEqual(selections, [['yamada-taro', 'suzuki-ichiro']]);
        assert.equal(document.querySelector('section[aria-label="山田花子の予定"]'), null);
      });
    });

    await suite.test('旧形式も同じフォームを使い、通信失敗後は値を保持して未確認の再POSTを止める', async () => {
      let intentCalls = 0;
      let saveCalls = 0;
      const fetchImpl: typeof fetch = async (input) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/intent') { intentCalls++; throw new Error('旧形式でNLIは呼びません'); }
        if (url.pathname === '/api/applications/expense') { saveCalls++; throw new Error('mock connection lost'); }
        if (url.pathname === '/api/applications') return response({ applications: initialApplications });
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      await withApp('/legacy', fetchImpl, async () => {
        await click('申請する');
        await click('交通費精算');
        assert.equal(field('利用日').value, '');
        assert.equal(field('金額').value, '');
        await change('利用日', '2026-11-01');
        await change('金額', '1200');
        await click('この内容で申請する');
        await waitFor(() => document.body.textContent?.includes('保存結果を確認できませんでした') === true, '保存結果が不明であることを案内しませんでした。');
        assert.equal(field('利用日').value, '2026-11-01');
        assert.equal(field('金額').value, '1200');
        assert.equal(field('金額').matches(':disabled'), true);
        assert.equal(saveCalls, 1);
        assert.equal(intentCalls, 0);
        await click('申請一覧で確認する');
        await waitFor(() => heading('申請一覧') && document.querySelectorAll('tbody tr').length === 2, '申請一覧で確認できませんでした。');
        assert.equal(saveCalls, 1);
        assert.equal(intentCalls, 0);
      });
    });
  } finally {
    try {
      if (activeRoot && act) await act(async () => activeRoot?.unmount());
    } finally {
      dom.window.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
