import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, errorMessage, fetchJson } from '@inui/feature-kit/web';
import { Feedback, Loading, useLatestRequest } from '@inui/feature-kit/react';
import { MAX_TITLE_LENGTH, parseExternal, parseLocalTask, parseLocalTasks } from './client.ts';
import type { ExternalResult, ExternalTask, LocalTask } from './client.ts';

const REASON_NAMES = { assigned: '担当', authored: '自分のPR', review_requested: 'レビュー依頼' } as const;
const SOURCES = {
  github: { name: 'GitHub', eyebrow: 'GITHUB', env: 'INUI_GITHUB_TOKEN', description: '自分が担当のIssue、自分が作ったPR、レビューを依頼されたPR' },
  backlog: { name: 'Backlog', eyebrow: 'BACKLOG', env: 'INUI_BACKLOG_SPACE・INUI_BACKLOG_API_KEY', description: '自分が担当の未完了の課題' },
} as const;

/** 連携先の失敗は、コードに応じて設定の確認か再試行を案内する。 */
function externalError(error: unknown, name: string): string {
  if (error instanceof ApiError && error.code === 'upstream_auth') return `${name}の認証に失敗しました。トークン・APIキーと権限を確認してください。`;
  if (error instanceof ApiError && error.code === 'invalid_config') return `${name}の連携設定の形式を確認してください。`;
  return errorMessage(error, `${name}からの取得`);
}

export default function TaskBoard() {
  return <div className="panel task-panel">
    <div className="panel-heading"><p className="eyebrow">TASKS</p><h2>タスク</h2>
      <p>自分のタスクと、GitHub・Backlogのチケットを並べて確認できます。連携先のチケットは読み取りだけです。</p></div>
    <div className="task-columns">
      <LocalTasks />
      <ExternalTasks source="github" />
      <ExternalTasks source="backlog" />
    </div>
  </div>;
}

function LocalTasks() {
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

  const open = tasks?.filter((task) => !task.done) ?? [];
  const done = tasks?.filter((task) => task.done) ?? [];
  return <section className="task-column" aria-labelledby="local-tasks-title">
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
    {tasks && tasks.length > 0 && <ul className="task-list">
      {[...open, ...done].map((task) => <li key={task.id} className={'task-item' + (task.done ? ' task-done' : '')}>
        <label>
          <input type="checkbox" checked={task.done} disabled={busy} onChange={(event) => {
            const checked = event.target.checked;
            void change(() => fetchJson('/api/tasks/local/' + task.id, { method: 'PATCH', body: { done: checked } }), 'タスクの更新');
          }} />
          <span>{task.title}</span>
        </label>
        <button className="text-button" type="button" disabled={busy} aria-label={`「${task.title}」を削除`}
          onClick={() => { void change(() => fetchJson('/api/tasks/local/' + task.id, { method: 'DELETE' }), 'タスクの削除'); }}>削除</button>
      </li>)}
    </ul>}
  </section>;
}

function ExternalTasks({ source }: { source: ExternalTask['source'] }) {
  const meta = SOURCES[source];
  const [result, setResult] = useState<ExternalResult>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requests = useLatestRequest();

  const load = useCallback(async () => {
    const request = requests.begin();
    setLoading(true);
    setError('');
    try {
      const data = parseExternal(await fetchJson('/api/tasks/' + source, { signal: request.signal }), source);
      if (request.isCurrent()) setResult(data);
    } catch (failure) {
      if (request.isCurrent()) setError(externalError(failure, meta.name));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [requests, source, meta.name]);
  useEffect(() => { void load(); }, [load]);

  return <section className="task-column" aria-labelledby={source + '-tasks-title'}>
    <p className="eyebrow">{meta.eyebrow}</p>
    <h3 id={source + '-tasks-title'}>{meta.name}</h3>
    <p className="task-source-note">{meta.description}</p>
    {result?.configured && <button className="text-button" type="button" disabled={loading} onClick={() => { void load(); }}>再読み込み</button>}
    {loading && <Loading message={meta.name + 'から読み込んでいます…'} />}
    {error && <Feedback message={error} onRetry={() => { void load(); }} />}
    {result && !result.configured && <div className="empty-state" role="status">
      <p>{meta.name}とは連携していません。</p>
      <span>アプリの起動前に環境変数 {meta.env} を設定すると表示できます。</span>
    </div>}
    {result?.configured && result.tasks.length === 0 && <div className="empty-state" role="status"><p>該当するチケットはありません。</p></div>}
    {result?.configured && result.tasks.length > 0 && <ul className="task-list">
      {result.tasks.map((task) => <li key={task.id} className="task-item task-external">
        <a href={task.url} target="_blank" rel="noopener noreferrer">
          <span className="task-key">{task.key}</span>
          <span>{task.title}</span>
        </a>
        <p className="task-meta">
          {task.kind === 'pull_request' && <span className="status-pill">PR</span>}
          {task.reasons?.map((reason) => <span key={reason} className="status-pill">{REASON_NAMES[reason]}</span>)}
          {task.status && <span className="status-pill">{task.status}</span>}
          {task.dueDate && <span>期限 {task.dueDate.replaceAll('-', '/')}</span>}
        </p>
      </li>)}
    </ul>}
  </section>;
}
