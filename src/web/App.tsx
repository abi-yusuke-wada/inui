import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Feedback, Loading, useLatestRequest } from '@inui/feature-kit/react';
import { errorMessage, fetchJson, parseDecision } from './api.ts';
import type { Notice, Screen } from './api.ts';

// 業務画面は機能パッケージから必要になったときだけ読み込み、入口の画面へ依存を持ち込まない。
const MarkdownViewer = lazy(() => import('@inui/feature-markdown/web'));
const TaskBoard = lazy(() => import('@inui/feature-tasks/web'));
const Whiteboard = lazy(() => import('@inui/feature-whiteboard/web'));

const SCREEN_LABELS: Record<Screen, string> = {
  markdown_view: 'Markdown表示',
  task_board: 'タスク',
  whiteboard: 'ホワイトボード',
};
const NOTICE_TITLES: Record<Notice, string> = {
  unsupported_feature: 'この機能はまだ利用できません',
  unsupported_operation: 'この操作には対応していません',
  clarify: 'もう少し詳しく教えてください',
};
const NOTICE_MESSAGES: Record<Notice, string> = {
  unsupported_feature: 'Markdownの表示・タスクの確認・ホワイトボードをご利用いただけます。',
  unsupported_operation: 'PRのマージ、Issue・PRの作成やクローズ、予定の登録・削除は、この画面では行えません。',
  clarify: '文書・タスク・ホワイトボードのどれを扱いたいか、用件を添えて入力してください。',
};
const EXAMPLES = ['Markdownを見やすく表示したい', '自分のタスクを確認したい', 'ホワイトボードに絵を描きたい'];
type MenuItem = readonly [Screen | 'unsupported_feature', string];
const MENU: Record<'documents' | 'work', { label: string; items: readonly MenuItem[] }> = {
  documents: { label: '文書', items: [['markdown_view', 'Markdown表示'], ['whiteboard', 'ホワイトボード'], ['unsupported_feature', '文書検索']] },
  work: { label: '仕事', items: [['task_board', 'タスク'], ['unsupported_feature', '会議室予約']] },
};
// 会話の履歴は画面の中だけに持ち、再読み込みで消す。長く使っても増え続けないよう古いものから捨てる。
const MAX_ENTRIES = 40;

/** 画面の読み込みに失敗しても、入力欄やメニューは残して案内する。 */
class ScreenBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    return this.state.failed
      ? <Feedback message="画面を読み込めませんでした。ページを再読み込みしてお試しください。" />
      : this.props.children;
  }
}
type View =
  | { kind: 'empty' }
  | { kind: 'notice'; intent: Notice; message: string }
  | { kind: 'screen'; screen: Screen; instance: number };
type ChatEntry =
  | { id: number; from: 'user'; text: string }
  | { id: number; from: 'inui'; kind: 'screen'; screen: Screen }
  | { id: number; from: 'inui'; kind: 'notice'; intent: Notice; message: string }
  | { id: number; from: 'inui'; kind: 'error'; message: string; retry: string };
// 共用体の型ごとにidを除く（Omitを共用体へ直接使うと、共通の項目しか残らない）。
type WithoutId<Entry> = Entry extends unknown ? Omit<Entry, 'id'> : never;
type NewEntry = WithoutId<ChatEntry>;

/** 吹き出しの形をしたアイコン。意味はボタンの文言で伝える。 */
function ChatIcon() {
  return <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z" />
    <path d="M8.5 8.5h7M8.5 11.5h4.5" />
  </svg>;
}

export function App() {
  const legacy = window.location.pathname.replace(/\/$/, '') === '/legacy';
  const [text, setText] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [routing, setRouting] = useState(false);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [category, setCategory] = useState<keyof typeof MENU | null>(null);
  // 最初に業務画面を開いた後は、入力欄を右下のパネルへしまい、業務画面に画面全体を使わせる。
  const [docked, setDocked] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const resultRegion = useRef<HTMLElement>(null);
  const instance = useRef(0);
  const entryId = useRef(0);
  const routeRequest = useLatestRequest();
  // 開いている画面に未保存の変更があるか（ホワイトボード）。画面を消す前に確認する。
  const unsaved = useRef(false);
  const reportUnsaved = useCallback((value: boolean) => { unsaved.current = value; }, []);

  function confirmLeave(): boolean {
    if (!unsaved.current) return true;
    if (!window.confirm('保存していない変更があります。破棄して続けますか？')) return false;
    unsaved.current = false;
    return true;
  }

  useEffect(() => {
    if (view.kind !== 'empty') resultRegion.current?.focus();
  }, [view]);

  useEffect(() => {
    if (panelOpen) input.current?.focus();
  }, [panelOpen]);

  // パネルを開いたときと、やり取りが増えたときは、新しいものが見えるよう履歴を最後までスクロールする。
  const logSize = entries.length + (routing ? 1 : 0);
  useEffect(() => {
    if (log.current && (panelOpen || logSize > 0)) log.current.scrollTop = log.current.scrollHeight;
  }, [logSize, panelOpen]);

  function addEntry(entry: NewEntry) {
    setEntries((current) => [...current, { ...entry, id: ++entryId.current } as ChatEntry].slice(-MAX_ENTRIES));
  }

  function showScreen(screen: Screen) {
    routeRequest.cancel();
    setRouting(false);
    setView({ kind: 'screen', screen, instance: ++instance.current });
  }

  function showNotice(intent: Notice) {
    routeRequest.cancel();
    setRouting(false);
    setView({ kind: 'notice', intent, message: NOTICE_MESSAGES[intent] });
  }

  async function route(submitted: string) {
    if (!submitted || submitted.length > 2000 || routing || !confirmLeave()) return;
    const request = routeRequest.begin();
    addEntry({ from: 'user', text: submitted });
    setText('');
    setRouting(true);
    // 前に表示した画面は、新しい入力の結果と取り違えないよう、送信した時点で消す。
    setView({ kind: 'empty' });
    try {
      const decision = parseDecision(await fetchJson('/api/intent', {
        method: 'POST', body: { text: submitted }, signal: request.signal,
      }));
      if (!request.isCurrent()) return;
      if (decision.kind === 'screen') {
        addEntry({ from: 'inui', kind: 'screen', screen: decision.ui });
        showScreen(decision.ui);
        setDocked(true);
        setPanelOpen(false);
      } else {
        addEntry({ from: 'inui', kind: 'notice', intent: decision.intent, message: decision.message });
      }
    } catch (error) {
      if (request.isCurrent()) addEntry({ from: 'inui', kind: 'error', message: errorMessage(error, '画面の表示'), retry: submitted });
    } finally {
      if (request.isCurrent()) setRouting(false);
    }
  }

  function closePanel() {
    setPanelOpen(false);
    toggle.current?.focus();
  }

  function resetMenu() {
    if (!confirmLeave()) return;
    routeRequest.cancel();
    setView({ kind: 'empty' });
    setCategory(null);
  }

  const lastEntry = entries.at(-1);
  // 入力欄・履歴・使い方は、最初は画面の中央に、業務画面を開いた後は右下のパネルに置く（同時には1か所だけ）。
  const conversation = <>
    {entries.length > 0 && <div className="chat-log" ref={log} role="log" aria-label="これまでのやり取り">
      <ol>
        {entries.map((entry) => <li key={entry.id} className={'chat-entry chat-' + entry.from}>
          {entry.from === 'user' && <p><span className="visually-hidden">あなた：</span>{entry.text}</p>}
          {entry.from === 'inui' && entry.kind === 'screen' && <p>「{SCREEN_LABELS[entry.screen]}」を開きました。</p>}
          {entry.from === 'inui' && entry.kind === 'notice' && <>
            <h3>{NOTICE_TITLES[entry.intent]}</h3>
            <p>{entry.message}</p>
          </>}
          {entry.from === 'inui' && entry.kind === 'error' && <div className="chat-error">
            <p>{entry.message}</p>
            {entry === lastEntry && !routing && <button className="button button-subtle" type="button"
              onClick={() => { void route(entry.retry); }}>もう一度試す</button>}
          </div>}
        </li>)}
        {routing && <li className="chat-entry chat-inui"><Loading message="入力を確認しています…" /></li>}
      </ol>
    </div>}
    <form className="intent-form" onSubmit={(event) => { event.preventDefault(); void route(text.trim()); }}>
      <label className="visually-hidden" htmlFor="intent-text">したいこと</label>
      <textarea id="intent-text" ref={input} rows={2} maxLength={2000} value={text}
        placeholder="例：自分のタスクを確認したい" onChange={(event) => setText(event.target.value)} />
      <button className="button button-primary intent-submit" type="submit" disabled={!text.trim() || routing}>
        {routing ? '確認しています…' : '画面を開く'}<span aria-hidden="true">↗</span>
      </button>
    </form>
    <p className="input-hint">キーボードでも、お使いの音声入力でも。</p>
    {helpOpen && <div className="help-panel" id="help">
      <p>したいことを入力して「画面を開く」を押してください。開いた画面は画面全体に表示され、入力欄は右下のボタンから開けます。</p>
      <div className="example-list">
        {EXAMPLES.map((example) =>
          <button type="button" key={example} onClick={() => { setText(example); input.current?.focus(); }}>
            {example}<span aria-hidden="true">↗</span>
          </button>)}
      </div>
      <a href="/legacy">比較用のメニューから探す</a>
    </div>}
  </>;

  const full = legacy ? view.kind === 'screen' : docked;
  return <div className={'app-shell' + (full ? ' app-shell-full' : '')}>
    <a className="skip-link" href="#main-content">本文へ移動</a>
    <header className="site-header">
      <a className="wordmark" href="/" aria-label="inui ホーム">inui<span className="wordmark-dot">.</span></a>
      <span className="header-caption">{legacy ? 'メニューから探す' : 'したいことから、画面へ'}</span>
      {legacy && view.kind === 'screen' && <button className="header-link" type="button" onClick={resetMenu}>← メニューに戻る</button>}
      {legacy
        ? <a className={'header-link' + (view.kind === 'screen' ? ' header-link-next' : '')} href="/">自然言語入力へ</a>
        : <button className="header-link" type="button" aria-expanded={helpOpen} aria-controls="help" onClick={() => {
          setHelpOpen(!helpOpen);
          if (docked && !helpOpen) setPanelOpen(true);
        }}>使い方</button>}
    </header>

    <main id="main-content">
      {!legacy && !docked && <section className={'composer' + (entries.length === 0 ? ' composer-intro' : '')} aria-label="用件を入力">
        <p className="eyebrow">YOUR INTENT, YOUR UI</p>
        <h1>{entries.length === 0 ? '今日は、何をしますか？' : 'ほかに、したいことはありますか？'}</h1>
        <p className="intro-copy">用件をひとことで。必要な画面を開きます。</p>
        {conversation}
      </section>}
      {!legacy && docked && <h1 className="visually-hidden">したいことから、画面へ</h1>}
      {!legacy && docked && view.kind === 'empty' && <div className="workspace-empty">
        <p>{routing ? '入力を確認しています…' : '右下のボタンから、したいことを入力してください。'}</p>
      </div>}

      {legacy && view.kind !== 'screen' && <section className="legacy-intro">
        <p className="eyebrow">MENU</p>
        <h1>メニューから探す</h1>
        <p className="intro-copy">分類を選び、使う画面を開きます。</p>
        {view.kind !== 'empty' && <button className="text-button" type="button" onClick={resetMenu}>← メニューに戻る</button>}
        {view.kind === 'empty' && <nav className="legacy-menu" aria-label="業務メニュー">
          {category === null
            ? (Object.keys(MENU) as (keyof typeof MENU)[]).map((key) =>
              <button type="button" key={key} onClick={() => setCategory(key)}>{MENU[key].label}<span aria-hidden="true">→</span></button>)
            : <>
              <button className="menu-back" type="button" onClick={() => setCategory(null)}>← 分類に戻る</button>
              {MENU[category].items.map(([target, label]) =>
                <button type="button" key={label} onClick={() => target === 'unsupported_feature'
                  ? showNotice('unsupported_feature') : showScreen(target)}>
                  {label}<span aria-hidden="true">→</span>
                </button>)}
            </>}
        </nav>}
      </section>}
      {legacy && view.kind === 'screen' && <h1 className="visually-hidden">メニューから探す</h1>}

      <section ref={resultRegion} className={'result-region' + (view.kind === 'screen' ? ' screen-full' : '')} tabIndex={-1}
        aria-label="用件に応じた画面" data-screen={view.kind === 'screen' ? view.screen : undefined}>
        {legacy && view.kind === 'notice' && <div className="panel notice-panel">
          <span className="notice-symbol" aria-hidden="true">i</span>
          <h2>{NOTICE_TITLES[view.intent]}</h2>
          <p>{view.message}</p>
          <button type="button" className="button button-subtle" onClick={resetMenu}>メニューへ戻る</button>
        </div>}
        {view.kind === 'screen' && <ScreenBoundary key={view.instance}>
          <Suspense fallback={<Loading message="画面を読み込んでいます…" />}>
            {view.screen === 'markdown_view' && <MarkdownViewer />}
            {view.screen === 'task_board' && <TaskBoard />}
            {view.screen === 'whiteboard' && <Whiteboard onUnsavedChange={reportUnsaved} />}
          </Suspense>
        </ScreenBoundary>}
      </section>
    </main>

    {!legacy && docked && <div className="chat-dock" data-screen={view.kind === 'screen' ? view.screen : undefined}>
      {panelOpen && <section className="chat-panel" id="intent-panel" aria-labelledby="intent-panel-title"
        onKeyDown={(event) => {
          // 日本語入力の変換をEscで取り消したときは、パネルを閉じない。
          if (event.key === 'Escape' && !event.nativeEvent.isComposing) closePanel();
        }}>
        <div className="chat-panel-header">
          <h2 id="intent-panel-title">inuiに頼む</h2>
          <button className="chat-close" type="button" onClick={closePanel}>
            <span aria-hidden="true">×</span><span className="visually-hidden">閉じる</span>
          </button>
        </div>
        {conversation}
      </section>}
      <button ref={toggle} className="chat-toggle" type="button" aria-expanded={panelOpen} aria-controls="intent-panel"
        onClick={() => { if (panelOpen) closePanel(); else setPanelOpen(true); }}>
        <ChatIcon /><span className="visually-hidden">{panelOpen ? '入力欄を閉じる' : 'したいことを入力'}</span>
      </button>
    </div>}
    {!full && <footer className="site-footer">inui<span aria-hidden="true"> · </span>仕事の入口を、もっと自然に。</footer>}
  </div>;
}
