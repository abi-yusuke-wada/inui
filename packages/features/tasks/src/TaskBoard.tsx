import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage, fetchJson } from '@inui/feature-kit/web';
import { Feedback, Loading, useLatestRequest } from '@inui/feature-kit/react';
import { MAX_TITLE_LENGTH, parseExternal, parseLocalTask, parseLocalTasks } from './client.ts';
import type { ExternalResult, LocalTask, TaskStatus } from './client.ts';

const REASON_NAMES = { assigned: '担当', authored: '自分のPR', review_requested: 'レビュー依頼' } as const;

/** GitHubの失敗は、コードに応じて設定の確認か再試行を案内する。 */
function githubError(error: unknown): string {
  if (error instanceof ApiError && error.code === 'upstream_auth') return 'GitHubの認証に失敗しました。トークンと権限を確認してください。';
  if (error instanceof ApiError && error.code === 'invalid_config') return 'GitHubの連携設定（INUI_GITHUB_TOKEN）の形式を確認してください。';
  return errorMessage(error, 'GitHubからの取得');
}

const VIEW_KEY = 'inui.tasks.view';
type View = 'todo' | 'kanban';
const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'To do' }, { status: 'doing', label: 'Doing' }, { status: 'done', label: 'Done' },
];

/** 最後に選んだ表示をブラウザに覚えさせる。保存できない環境ではTodo表示から始める。 */
function savedView(): View {
  try { return window.localStorage.getItem(VIEW_KEY) === 'kanban' ? 'kanban' : 'todo'; } catch { return 'todo'; }
}
function saveView(view: View) {
  try { window.localStorage.setItem(VIEW_KEY, view); } catch { /* 保存できなくても表示は切り替える。 */ }
}

export default function TaskBoard() {
  const [view, setView] = useState<View>(savedView);
  return <div className="panel task-panel">
    <div className="panel-heading"><p className="eyebrow">TASKS</p><h2>タスク</h2>
      <p>自分のタスクと、GitHubのIssue・PRを並べて確認できます。GitHubのIssue・PRは読み取りだけです。</p></div>
    <fieldset className="task-view-switch">
      <legend className="visually-hidden">自分のタスクの表示</legend>
      {([['todo', 'Todo'], ['kanban', '看板']] as const).map(([value, label]) =>
        <button key={value} type="button" className={'button ' + (view === value ? 'button-primary' : 'button-subtle')}
          aria-pressed={view === value} onClick={() => { setView(value); saveView(value); }}>{label}</button>)}
    </fieldset>
    <div className={'task-columns' + (view === 'kanban' ? ' task-columns-kanban' : '')}>
      <LocalTasks view={view} />
      <GitHubTasks />
    </div>
  </div>;
}

function LocalTasks({ view }: { view: View }) {
  const [tasks, setTasks] = useState<LocalTask[]>();
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // 同じ描画の間に届いた2回目の送信も止めるため、stateとは別に保持する。
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const requests = useLatestRequest();
  const changes = useLatestRequest();

  const load = useCallback(async () => {
    const request = requests.begin();
    setLoading(true);
    setError('');
    try {
      const rows = parseLocalTasks(await fetchJson('/api/tasks/local', { signal: request.signal }));
      if (request.isCurrent()) setTasks(rows);
    } catch (failure) {
      if (request.isCurrent()) setError(errorMessage(failure, 'タスクの取得'));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [requests]);
  useEffect(() => { void load(); }, [load]);

  /** 変更は1件ずつ送り、完了後に一覧を読み直して保存済みの状態を表示する。 */
  async function change(action: () => Promise<unknown>, label: string) {
    if (busyRef.current) return;
    const request = changes.begin();
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      if (!request.isCurrent()) return;
      await load();
    } catch (failure) {
      if (request.isCurrent()) setError(errorMessage(failure, label));
    } finally {
      busyRef.current = false;
      if (request.isCurrent()) setBusy(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > MAX_TITLE_LENGTH) return;
    void change(async () => {
      parseLocalTask(await fetchJson('/api/tasks/local', { method: 'POST', body: { title: trimmed } }));
      setTitle('');
    }, 'タスクの追加');
  }

  const move = (task: LocalTask, status: TaskStatus) => {
    if (task.status === status) return;
    void change(() => fetchJson('/api/tasks/local/' + task.id, { method: 'PATCH', body: { status } }), 'タスクの移動');
  };
  const remove = (task: LocalTask) => {
    void change(() => fetchJson('/api/tasks/local/' + task.id, { method: 'DELETE' }), 'タスクの削除');
  };

  return <section className="task-column task-column-local" aria-labelledby="local-tasks-title">
    <p className="eyebrow">MY TASKS</p>
    <h3 id="local-tasks-title">自分のタスク</h3>
    <form className="task-add" onSubmit={add}>
      <label className="visually-hidden" htmlFor="task-title">追加するタスク</label>
      <input id="task-title" type="text" maxLength={MAX_TITLE_LENGTH} value={title} placeholder="例：ADRの下書きを書く"
        disabled={busy} onChange={(event) => setTitle(event.target.value)} />
      <button className="button button-primary" type="submit" disabled={busy || !title.trim()}>追加</button>
    </form>
    {loading && !tasks && <Loading message="タスクを読み込んでいます…" />}
    {error && <Feedback message={error} onRetry={() => { void load(); }} />}
    {tasks && tasks.length === 0 && <div className="empty-state" role="status"><p>タスクはまだありません。</p><span>やることを入力して「追加」を押してください。</span></div>}
    {tasks && tasks.length > 0 && (view === 'kanban'
      ? <Kanban tasks={tasks} busy={busy} onMove={move} onRemove={remove} />
      : <ul className="task-list">
        {tasks.map((task) => <li key={task.id} className={'task-item' + (task.done ? ' task-done' : '')}>
          <label>
            <input type="checkbox" checked={task.done} disabled={busy} onChange={(event) => {
              const checked = event.target.checked;
              void change(() => fetchJson('/api/tasks/local/' + task.id, { method: 'PATCH', body: { done: checked } }), 'タスクの更新');
            }} />
            <span>{task.title}</span>
            {task.status === 'doing' && <span className="status-pill">Doing</span>}
          </label>
          <button className="text-button" type="button" disabled={busy} aria-label={`「${task.title}」を削除`}
            onClick={() => remove(task)}>削除</button>
        </li>)}
      </ul>)}
  </section>;
}

/**
 * 自分のタスクを To do・Doing・Done の列に並べる。カードはドラッグで別の列へ移せる。
 * GitHubのIssue・PRは看板に載せず、別の欄で参照だけにする（inuiで閉じると管理が二重になるため）。
 * キーボードでも操作できるよう、カードに「←」「→」の移動ボタンを付ける。
 */
function Kanban({ tasks, busy, onMove, onRemove }: {
  tasks: LocalTask[];
  busy: boolean;
  onMove: (task: LocalTask, status: TaskStatus) => void;
  onRemove: (task: LocalTask) => void;
}) {
  const [over, setOver] = useState<TaskStatus>();
  const dragged = useRef<string | undefined>(undefined);
  function drop(status: TaskStatus, id: string | undefined) {
    setOver(undefined);
    const task = tasks.find((item) => item.id === id);
    if (task && !busy) onMove(task, status);
  }
  return <div className="kanban">
    {COLUMNS.map(({ status, label }, index) => {
      const cards = tasks.filter((task) => task.status === status);
      return <section key={status} className={'kanban-column' + (over === status ? ' kanban-column-over' : '')}
        aria-label={`${label}（${cards.length}件）`}
        onDragOver={(event) => { event.preventDefault(); setOver(status); }}
        onDragLeave={() => setOver(undefined)}
        onDrop={(event) => {
          event.preventDefault();
          drop(status, event.dataTransfer?.getData('text/plain') || dragged.current);
        }}>
        <h4>{label}<span className="kanban-count">{cards.length}</span></h4>
        {cards.length === 0 ? <p className="no-events">カードはありません。</p> : <ul className="task-list">
          {cards.map((task) => {
            const previous = COLUMNS[index - 1];
            const next = COLUMNS[index + 1];
            return <li key={task.id} className={'task-item kanban-card' + (task.done ? ' task-done' : '')}
              draggable={!busy}
              onDragStart={(event) => { dragged.current = task.id; event.dataTransfer?.setData('text/plain', task.id); }}
              onDragEnd={() => { dragged.current = undefined; setOver(undefined); }}>
              <span className="kanban-title">{task.title}</span>
              <span className="kanban-actions">
                {previous && <button className="text-button" type="button" disabled={busy}
                  aria-label={`「${task.title}」を${previous.label}へ移動`} onClick={() => onMove(task, previous.status)}>←</button>}
                {next && <button className="text-button" type="button" disabled={busy}
                  aria-label={`「${task.title}」を${next.label}へ移動`} onClick={() => onMove(task, next.status)}>→</button>}
                <button className="text-button kanban-remove" type="button" disabled={busy}
                  aria-label={`「${task.title}」を削除`} onClick={() => onRemove(task)}>削除</button>
              </span>
            </li>;
          })}
        </ul>}
      </section>;
    })}
  </div>;
}

/** 自分が担当のIssue、自分が作ったPR、レビューを依頼されたPRを、リンクとして並べる。 */
function GitHubTasks() {
  const [result, setResult] = useState<ExternalResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requests = useLatestRequest();

  const load = useCallback(async () => {
    const request = requests.begin();
    setLoading(true);
    setError('');
    try {
      const data = parseExternal(await fetchJson('/api/tasks/github', { signal: request.signal }));
      if (request.isCurrent()) setResult(data);
    } catch (failure) {
      if (request.isCurrent()) setError(githubError(failure));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [requests]);
  useEffect(() => { void load(); }, [load]);

  return <section className="task-column" aria-labelledby="github-tasks-title">
    <p className="eyebrow">GITHUB</p>
    <h3 id="github-tasks-title">GitHub<span className="status-pill task-readonly">参照のみ</span></h3>
    <p className="task-source-note">自分が担当のIssue、自分が作ったPR、レビューを依頼されたPR</p>
    {result?.configured && <button className="text-button" type="button" disabled={loading} onClick={() => { void load(); }}>再読み込み</button>}
    {loading && <Loading message="GitHubから読み込んでいます…" />}
    {error && <Feedback message={error} onRetry={() => { void load(); }} />}
    {result && !result.configured && <div className="empty-state" role="status">
      <p>GitHubとは連携していません。</p>
      <span>アプリの起動前に環境変数 INUI_GITHUB_TOKEN を設定すると表示できます。</span>
    </div>}
    {result?.configured && result.tasks.length === 0 && result.omitted === 0 && <div className="empty-state" role="status"><p>該当するチケットはありません。</p></div>}
    {result?.configured && result.omitted > 0 && <p className="task-source-note" role="status">
      件数が多いため、{result.omitted}件を表示していません（条件ごとに更新が新しい100件まで表示）。GitHubで確認してください。
    </p>}
    {result?.configured && result.tasks.length > 0 && <ul className="task-list">
      {result.tasks.map((task) => <li key={task.id} className="task-item task-external">
        <a href={task.url} target="_blank" rel="noopener noreferrer">
          <span className="task-key">{task.key}</span>
          <span>{task.title}</span>
        </a>
        <p className="task-meta">
          {task.kind === 'pull_request' && <span className="status-pill">PR</span>}
          {task.reasons?.map((reason) => <span key={reason} className="status-pill">{REASON_NAMES[reason]}</span>)}
        </p>
      </li>)}
    </ul>}
  </section>;
}
