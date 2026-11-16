import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { PeopleSelection } from '@inui/feature-schedule/client';
import { Feedback, Loading, useLatestRequest } from '@inui/feature-kit/react';
import { errorMessage, fetchJson, parseDecision } from './api.ts';
import type { Notice, Screen } from './api.ts';

// 業務画面は機能パッケージから必要になったときだけ読み込み、入口の画面へ依存を持ち込まない。
const MarkdownViewer = lazy(() => import('@inui/feature-markdown/web'));
const TaskBoard = lazy(() => import('@inui/feature-tasks/web'));
const Whiteboard = lazy(() => import('@inui/feature-whiteboard/web'));
const Schedules = lazy(() => import('@inui/feature-schedule/web'));

const NOTICE_TITLES: Record<Notice, string> = {
  unsupported_feature: 'この機能はまだ利用できません',
  unsupported_operation: 'この操作には対応していません',
  clarify: 'もう少し詳しく教えてください',
};
const NOTICE_MESSAGES: Record<Notice, string> = {
  unsupported_feature: 'Markdownの表示・タスクの確認・ホワイトボード・予定比較をご利用いただけます。',
  unsupported_operation: 'PRのマージ、Issue・PRの作成やクローズ、予定の登録・削除は、この画面では行えません。',
  clarify: '文書・タスク・ホワイトボード・予定のどれを扱いたいか、用件を添えて入力してください。',
};
const EXAMPLES = ['Markdownを見やすく表示したい', '自分のタスクを確認したい', 'ホワイトボードに絵を描きたい', '山田太郎さんと佐藤花子さんの予定を比較したい'];
type MenuItem = readonly [Screen | 'unsupported_feature', string];
const MENU: Record<'documents' | 'work', { label: string; items: readonly MenuItem[] }> = {
  documents: { label: '文書', items: [['markdown_view', 'Markdown表示'], ['whiteboard', 'ホワイトボード'], ['unsupported_feature', '文書検索']] },
  work: { label: '仕事', items: [['task_board', 'タスク'], ['schedule_compare', '予定比較'], ['unsupported_feature', '会議室予約']] },
};
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
  | { kind: 'screen'; screen: Screen; instance: number; people?: PeopleSelection };

export function App() {
  const legacy = window.location.pathname.replace(/\/$/, '') === '/legacy';
  const [text, setText] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [routing, setRouting] = useState(false);
  const [routingError, setRoutingError] = useState('');
  const [category, setCategory] = useState<keyof typeof MENU | null>(null);
  // 一度でも送信したら見出しを「ほかに…」へ切り替え、案内を消したときにレイアウトが戻らないようにする。
  const [asked, setAsked] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const resultRegion = useRef<HTMLElement>(null);
  const instance = useRef(0);
  const routeRequest = useLatestRequest();

  useEffect(() => {
    if (view.kind !== 'empty') resultRegion.current?.focus();
  }, [view]);

  function showScreen(screen: Screen, people?: PeopleSelection) {
    routeRequest.cancel();
    setRouting(false);
    setRoutingError('');
    setView({ kind: 'screen', screen, instance: ++instance.current, ...(people ? { people } : {}) });
  }

  function showNotice(intent: Notice, message = NOTICE_MESSAGES[intent]) {
    routeRequest.cancel();
    setRouting(false);
    setRoutingError('');
    setView({ kind: 'notice', intent, message });
  }

  async function route() {
    const submitted = text.trim();
    if (!submitted || submitted.length > 2000) return;
    const request = routeRequest.begin();
    setAsked(true);
    setRouting(true);
    setRoutingError('');
    // 前の案内は、新しい入力の結果と取り違えないよう、送信した時点で消す。開いている業務画面はそのまま残す。
    setView((current) => current.kind === 'notice' ? { kind: 'empty' } : current);
    try {
      const decision = parseDecision(await fetchJson('/api/intent', {
        method: 'POST', body: { text: submitted }, signal: request.signal,
      }));
      if (!request.isCurrent()) return;
      if (decision.kind === 'screen') showScreen(decision.ui, decision.people);
      else showNotice(decision.intent, decision.message);
    } catch (error) {
      if (request.isCurrent()) setRoutingError(errorMessage(error, '画面の表示'));
    } finally {
      if (request.isCurrent()) setRouting(false);
    }
  }

  function resetMenu() {
    routeRequest.cancel();
    setView({ kind: 'empty' });
    setCategory(null);
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">本文へ移動</a>
    <header className="site-header">
      <a className="wordmark" href="/" aria-label="inui ホーム">inui<span className="wordmark-dot">.</span></a>
      <span className="header-caption">{legacy ? 'メニューから探す' : 'したいことから、画面へ'}</span>
      {legacy
        ? <a className="header-link" href="/">自然言語入力へ</a>
        : <button className="header-link" type="button" aria-expanded={helpOpen} aria-controls="help" onClick={() => setHelpOpen(!helpOpen)}>使い方</button>}
    </header>

    <main id="main-content">
      {!legacy && <section className={'composer ' + (view.kind === 'empty' && !asked ? 'composer-intro' : '')} aria-label="用件を入力">
        <p className="eyebrow">YOUR INTENT, YOUR UI</p>
        <h1>{view.kind === 'empty' && !asked ? '今日は、何をしますか？' : 'ほかに、したいことはありますか？'}</h1>
        <p className="intro-copy">用件をひとことで。必要な画面を開きます。</p>
        <form className="intent-form" onSubmit={(event) => { event.preventDefault(); void route(); }}>
          <label className="visually-hidden" htmlFor="intent-text">したいこと</label>
          <textarea id="intent-text" ref={input} rows={2} maxLength={2000} value={text}
            placeholder="例：自分のタスクを確認したい"
            onChange={(event) => {
              routeRequest.cancel();
              setRouting(false);
              setRoutingError('');
              setText(event.target.value);
            }} />
          <button className="button button-primary intent-submit" type="submit" disabled={!text.trim() || routing}>
            {routing ? '確認しています…' : '画面を開く'}<span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className="input-hint">キーボードでも、お使いの音声入力でも。</p>
        {helpOpen && <div className="help-panel" id="help">
          <p>したいことを入力して「画面を開く」を押してください。開いた画面で、表示する内容を選んだりタスクを追加したりできます。</p>
          <div className="example-list">
            {EXAMPLES.map((example) =>
              <button type="button" key={example} onClick={() => {
                routeRequest.cancel(); setRouting(false); setRoutingError(''); setText(example); input.current?.focus();
              }}>{example}<span aria-hidden="true">↗</span></button>)}
          </div>
          <a href="/legacy">比較用のメニューから探す</a>
        </div>}
        {routing && <Loading message="入力を確認しています…" />}
        {routingError && <Feedback message={routingError} onRetry={() => { void route(); }} />}
      </section>}

      {legacy && <section className="legacy-intro">
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

      <section ref={resultRegion} className="result-region" tabIndex={-1} aria-label="用件に応じた画面">
        {view.kind === 'notice' && <div className="panel notice-panel">
          <span className="notice-symbol" aria-hidden="true">i</span>
          <h2>{NOTICE_TITLES[view.intent]}</h2>
          <p>{view.message}</p>
          <button type="button" className="button button-subtle" onClick={() => legacy ? resetMenu() : input.current?.focus()}>
            {legacy ? 'メニューへ戻る' : '入力を直す'}
          </button>
        </div>}
        {view.kind === 'screen' && <ScreenBoundary key={view.instance}>
          <Suspense fallback={<Loading message="画面を読み込んでいます…" />}>
            {view.screen === 'markdown_view' && <MarkdownViewer />}
            {view.screen === 'task_board' && <TaskBoard />}
            {view.screen === 'whiteboard' && <Whiteboard />}
            {view.screen === 'schedule_compare' && <Schedules people={view.people} />}
          </Suspense>
        </ScreenBoundary>}
      </section>
    </main>
    <footer className="site-footer">inui<span aria-hidden="true"> · </span>仕事の入口を、もっと自然に。</footer>
  </div>;
}
