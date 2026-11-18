import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Root } from 'react-dom/client';
import type { LocalTask } from '@inui/feature-tasks/client';

/** APIだけをモックするDOM操作テスト。実ブラウザやNLIの精度測定ではない。 */
test('PoCの利用経路をJSDOMで操作する（実ブラウザではない）', { concurrency: false }, async (suite) => {
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
    Node: dom.window.Node,
    Element: dom.window.Element,
    DocumentFragment: dom.window.DocumentFragment,
    HTMLTemplateElement: dom.window.HTMLTemplateElement,
    NodeFilter: dom.window.NodeFilter,
    NamedNodeMap: dom.window.NamedNodeMap,
    HTMLFormElement: dom.window.HTMLFormElement,
    DOMParser: dom.window.DOMParser,
    File: dom.window.File,
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

    await suite.test('自然文からタスク画面を開き、追加を1回だけ送って一覧を読み直し、連携先の状態を表示する', async () => {
      const tasks: LocalTask[] = [];
      let addCalls = 0;
      let resolveAdd: ((value: Response) => void) | undefined;
      const fetchImpl: typeof fetch = async (input, options) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/intent') {
          assert.equal(options?.method, 'POST');
          return response({ kind: 'screen', intent: 'task_board', ui: 'task_board' });
        }
        if (url.pathname === '/api/tasks/local' && options?.method === 'POST') {
          addCalls++;
          const { title } = JSON.parse(String(options.body)) as { title: string };
          const task: LocalTask = { id: '00000000-0000-4000-8000-00000000000' + addCalls, title, status: 'todo', done: false, createdAt: '2026-11-16T00:00:00.000Z' };
          return await new Promise<Response>((resolve) => {
            resolveAdd = (value) => { tasks.push(task); resolve(value); };
          }).then(() => response({ task }, 201));
        }
        if (url.pathname === '/api/tasks/local') return response({ tasks });
        if (url.pathname.startsWith('/api/tasks/local/') && options?.method === 'PATCH') {
          const task = tasks.find((item) => url.pathname.endsWith(item.id));
          assert.ok(task);
          task.done = (JSON.parse(String(options.body)) as { done: boolean }).done;
          task.status = task.done ? 'done' : 'todo';
          return response({ task });
        }
        if (url.pathname === '/api/tasks/github') return response({ configured: false });
        if (url.pathname === '/api/tasks/backlog') {
          return response({ configured: true, tasks: [{ id: 'backlog-1', source: 'backlog', kind: 'backlog_issue', key: 'PROJ-1',
            title: '顧客向け資料の修正', url: 'https://example.backlog.jp/view/PROJ-1', updatedAt: '2026-11-15T00:00:00Z', status: '処理中' }] });
        }
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      await withApp('/', fetchImpl, async () => {
        assert.equal(document.querySelector('nav[aria-label="業務メニュー"]'), null);
        await change('したいこと', 'やることをメモしておきたい');
        await click('画面を開く');
        await waitFor(() => heading('自分のタスク') && document.body.textContent?.includes('タスクはまだありません') === true,
          'タスク画面が開きませんでした。');
        await waitFor(() => document.body.textContent?.includes('GitHubとは連携していません') === true, 'GitHubの未設定を案内しませんでした。');
        await waitFor(() => document.body.textContent?.includes('PROJ-1') === true, 'Backlogの課題が表示されませんでした。');
        const link = [...document.querySelectorAll('a')].find((node) => node.textContent?.includes('PROJ-1'));
        assert.equal(link?.getAttribute('rel'), 'noopener noreferrer');
        await change('追加するタスク', 'ADRの下書きを書く');
        const form = field('追加するタスク').closest('form');
        assert.ok(form);
        await react.act(async () => {
          form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
          form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        });
        assert.equal(addCalls, 1);
        assert.ok(resolveAdd);
        await react.act(async () => resolveAdd?.(new Response()));
        await waitFor(() => document.body.textContent?.includes('ADRの下書きを書く') === true && field('追加するタスク').value === '',
          '追加したタスクが表示されませんでした。');
        await react.act(async () => (field('ADRの下書きを書く') as HTMLInputElement).click());
        await waitFor(() => (field('ADRの下書きを書く') as HTMLInputElement).checked, '完了の状態が保存されませんでした。');
        assert.equal(addCalls, 1);
      });
    });

    await suite.test('タスクをTodoと看板で切り替え、看板では移動ボタンとドラッグで列を移し、連携先は参照のみにする', async () => {
      const tasks: LocalTask[] = [
        { id: '00000000-0000-4000-8000-0000000000a1', title: '設計を書く', status: 'todo', done: false, createdAt: '2026-11-16T00:00:00.000Z' },
        { id: '00000000-0000-4000-8000-0000000000a2', title: 'レビューする', status: 'doing', done: false, createdAt: '2026-11-16T00:00:01.000Z' },
      ];
      const patches: unknown[] = [];
      const fetchImpl: typeof fetch = async (input, options) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/tasks/local') return response({ tasks });
        if (url.pathname.startsWith('/api/tasks/local/') && options?.method === 'PATCH') {
          const body = JSON.parse(String(options.body)) as { status: LocalTask['status'] };
          patches.push(body);
          const task = tasks.find((item) => url.pathname.endsWith(item.id));
          assert.ok(task);
          task.status = body.status;
          task.done = body.status === 'done';
          return response({ task });
        }
        if (url.pathname === '/api/tasks/github' || url.pathname === '/api/tasks/backlog') return response({ configured: false });
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      dom.window.localStorage.removeItem('inui.tasks.view');
      const column = (label: string) => document.querySelector(`section[aria-label^="${label}（"]`);
      await withApp('/legacy', fetchImpl, async () => {
        await click('仕事');
        await click('タスク');
        await waitFor(() => document.body.textContent?.includes('設計を書く') === true, 'タスクを表示しませんでした。');
        assert.equal(button('Todo').getAttribute('aria-pressed'), 'true');
        assert.equal(column('To do'), null);
        // GitHub・Backlogの欄は参照のみで、看板には載せない。
        assert.equal(document.querySelectorAll('.task-readonly').length, 2);
        await click('看板');
        assert.equal(dom.window.localStorage.getItem('inui.tasks.view'), 'kanban');
        assert.match(column('To do')?.textContent ?? '', /設計を書く/);
        assert.match(column('Doing')?.textContent ?? '', /レビューする/);
        assert.equal(document.body.textContent?.includes('Backlog（'), false);
        const move = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === '「設計を書く」をDoingへ移動');
        assert.ok(move);
        await react.act(async () => move.click());
        await waitFor(() => /設計を書く/.test(column('Doing')?.textContent ?? ''), '移動ボタンで列を移せませんでした。');
        // ドラッグ＆ドロップは、JSDOMにDataTransferがないため、データを持つdropイベントで再現する。
        const card = [...(column('Doing')?.querySelectorAll('li') ?? [])].find((node) => node.textContent?.includes('レビューする'));
        const done = column('Done');
        assert.ok(card && done);
        assert.equal(card.getAttribute('draggable'), 'true');
        const dataTransfer = { data: '', setData(_type: string, value: string) { this.data = value; }, getData() { return this.data; } };
        await react.act(async () => {
          const start = new dom.window.Event('dragstart', { bubbles: true });
          Object.defineProperty(start, 'dataTransfer', { value: dataTransfer });
          card.dispatchEvent(start);
          const drop = new dom.window.Event('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
          done.dispatchEvent(drop);
        });
        await waitFor(() => /レビューする/.test(column('Done')?.textContent ?? ''), 'ドラッグで列を移せませんでした。');
        assert.deepEqual(patches, [{ status: 'doing' }, { status: 'done' }]);
      });
      // 次に開いたときは、最後に選んだ看板の表示から始める。
      await withApp('/legacy', fetchImpl, async () => {
        await click('仕事');
        await click('タスク');
        await waitFor(() => column('Done') !== null, '前回の表示を覚えていませんでした。');
        assert.equal(button('看板').getAttribute('aria-pressed'), 'true');
      });
      dom.window.localStorage.removeItem('inui.tasks.view');
    });

    await suite.test('旧形式のメニューからMarkdown表示を開き、選んだファイルを送信せずに無害化して表示する', async () => {
      const requests: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        requests.push(String(input));
        throw new Error('Markdown表示ではAPIを呼びません');
      };
      await withApp('/legacy', fetchImpl, async () => {
        await click('文書');
        await click('Markdown表示');
        await waitFor(() => heading('Markdownを読む'), 'Markdown表示が開きませんでした。');
        const input = document.querySelector<HTMLInputElement>('input[type="file"]');
        assert.ok(input);
        const select = async (file: File) => {
          Object.defineProperty(input, 'files', { configurable: true, value: [file] });
          await react.act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
        };
        await select(new dom.window.File(['plain'], 'memo.txt', { type: 'text/plain' }));
        await waitFor(() => document.body.textContent?.includes('Markdownファイル（.md・.markdown）を選んでください') === true,
          '拡張子の誤りを案内しませんでした。');
        const source = '# 設計の記録\n\n## 背景\n\n<script>window.injected = true</script>\n\n| 案 | 費用 |\n| --- | --- |\n| A | なし |\n';
        await select(new dom.window.File([source], 'adr.md', { type: 'text/markdown' }));
        await waitFor(() => document.querySelector('article h1')?.textContent === '設計の記録', 'Markdownが表示されませんでした。');
        const toc = document.querySelector('nav[aria-label="目次"]');
        assert.deepEqual([...(toc?.querySelectorAll('a') ?? [])].map((link) => [link.textContent, link.getAttribute('href')]),
          [['設計の記録', '#md-h-1'], ['背景', '#md-h-2']]);
        assert.equal(document.querySelector('article script'), null);
        assert.equal(document.querySelectorAll('article td').length, 2);
        assert.match(document.body.textContent ?? '', /表示中: adr\.md/);
        assert.deepEqual(requests, []);
      });
    });

    await suite.test('旧形式のメニューからホワイトボードを開き、作成・描画・保存を1件ずつ行う（Excalidrawはスタブ）', async () => {
      const boards: { id: string; name: string; updatedAt: string }[] = [];
      const saved: unknown[] = [];
      const fetchImpl: typeof fetch = async (input, options) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/whiteboards' && options?.method === 'POST') {
          const { name } = JSON.parse(String(options.body)) as { name: string };
          const board = { id: '00000000-0000-4000-8000-0000000000b1', name, updatedAt: '2026-11-17T00:00:00.000Z' };
          boards.push(board);
          return response({ board }, 201);
        }
        if (url.pathname === '/api/whiteboards') return response({ boards });
        if (url.pathname === '/api/whiteboards/00000000-0000-4000-8000-0000000000b1') {
          const board = boards[0];
          assert.ok(board);
          if (options?.method === 'PATCH') {
            saved.push(JSON.parse(String(options.body)));
            return response({ board });
          }
          return response({ board: { ...board, scene: { elements: [], files: {}, appState: {} } } });
        }
        throw new Error('想定外のAPI: ' + url.pathname);
      };
      await withApp('/legacy', fetchImpl, async () => {
        await click('文書');
        await click('ホワイトボード');
        await waitFor(() => heading('ホワイトボード') && document.body.textContent?.includes('ボードはまだありません') === true,
          'ホワイトボードが開きませんでした。');
        // JSDOMはCSSを読み込まないため、ExcalidrawのCSSの読み込み完了を再現する。
        const link = document.querySelector<HTMLLinkElement>('link[href="/excalidraw/index.css"]');
        assert.ok(link);
        assert.equal(window.EXCALIDRAW_ASSET_PATH, '/excalidraw/');
        await react.act(async () => { link.dispatchEvent(new dom.window.Event('load')); });
        await change('新しいボードの名前', '設計のラフ');
        await click('作成');
        await waitFor(() => document.querySelector('[data-testid="excalidraw-stub"]') !== null, 'ボードが開きませんでした。');
        assert.match(document.body.textContent ?? '', /保存済み/);
        // 開いた直後からドラッグで描けるよう、ペンが選ばれている。
        assert.equal(window.inuiTestActiveTool, 'freedraw');
        await react.act(async () => { window.dispatchEvent(new dom.window.Event('inui-test-draw')); });
        await waitFor(() => document.body.textContent?.includes('未保存の変更があります') === true, '未保存の変更を表示しませんでした。');
        assert.deepEqual(saved, []);
        // 未保存の変更があるときは、画面を閉じる前に確認し、キャンセルすれば残す。
        const confirms: string[] = [];
        dom.window.confirm = (message?: string) => { confirms.push(String(message)); return false; };
        await click('← メニューに戻る');
        assert.equal(confirms.length, 1);
        assert.match(confirms[0] ?? '', /保存していない変更があります/);
        assert.ok(document.querySelector('[data-testid="excalidraw-stub"]'));
        await click('保存');
        await waitFor(() => document.body.textContent?.includes('保存しました') === true, '保存できませんでした。');
        assert.equal(saved.length, 1);
        const body = saved[0] as unknown as { name: string; scene: { elements: { type: string }[]; appState: unknown } };
        assert.equal(body.name, '設計のラフ');
        assert.deepEqual(body.scene.elements.map((element) => element.type), ['freedraw']);
        assert.deepEqual(body.scene.appState, { viewBackgroundColor: '#ffffff' });
        assert.match(document.body.textContent ?? '', /保存済み/);
        // 保存した後は確認なしでメニューへ戻れる。
        await click('← メニューに戻る');
        assert.equal(confirms.length, 1);
        await waitFor(() => button('文書') !== undefined, 'メニューへ戻れませんでした。');
      });
    });

    await suite.test('再送信すると、前に表示した案内や業務画面を消してから新しい結果を表示する', async () => {
      const pending: ((value: Response) => void)[] = [];
      let calls = 0;
      const fetchImpl: typeof fetch = async (input) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/tasks/local') return response({ tasks: [] });
        if (url.pathname === '/api/tasks/github' || url.pathname === '/api/tasks/backlog') return response({ configured: false });
        if (url.pathname !== '/api/intent') throw new Error('想定外のAPI: ' + url.pathname);
        calls++;
        if (calls === 1) return response({ kind: 'notice', intent: 'clarify', message: '目的を特定できませんでした。' });
        return await new Promise<Response>((resolve) => { pending.push(resolve); });
      };
      await withApp('/', fetchImpl, async () => {
        await change('したいこと', '開いて');
        await click('画面を開く');
        await waitFor(() => heading('もう少し詳しく教えてください'), '曖昧な入力の案内を表示しませんでした。');
        await change('したいこと', '自分のタスクを確認したい');
        await click('画面を開く');
        // 結果を待つあいだも、前の案内は表示しない。見出しは送信後の表示のまま。
        assert.equal(heading('もう少し詳しく教えてください'), false);
        assert.equal(heading('ほかに、したいことはありますか？'), true);
        assert.match(document.body.textContent ?? '', /入力を確認しています/);
        await react.act(async () => pending.shift()?.(response({ kind: 'screen', intent: 'task_board', ui: 'task_board' })));
        await waitFor(() => heading('自分のタスク'), 'タスク画面を表示しませんでした。');
        // 業務画面を開いた後の再送信でも、前の画面は送信した時点で消す。
        await change('したいこと', 'お腹がすいた');
        await click('画面を開く');
        assert.equal(heading('自分のタスク'), false);
        assert.equal(heading('タスク'), false);
        await react.act(async () => pending.shift()?.(response({ kind: 'notice', intent: 'unsupported_feature', message: '対象外です。' })));
        await waitFor(() => heading('この機能はまだ利用できません'), '新しい案内を表示しませんでした。');
        assert.equal(calls, 3);
      });
    });

    await suite.test('旧形式のメニューで対象外の機能を選ぶと、NLIを呼ばずに案内する', async () => {
      let calls = 0;
      await withApp('/legacy', async () => { calls++; throw new Error('呼びません'); }, async () => {
        await click('仕事');
        // 予定比較は廃止したため、仕事の分類はタスクと対象外の会議室予約だけにする。
        assert.deepEqual([...document.querySelectorAll('nav[aria-label="業務メニュー"] button')].map(visibleText),
          ['← 分類に戻る', 'タスク', '会議室予約']);
        await click('会議室予約');
        await waitFor(() => heading('この機能はまだ利用できません'), '対象外の機能を案内しませんでした。');
        await click('メニューへ戻る');
        assert.ok(button('文書'));
        assert.equal(calls, 0);
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
