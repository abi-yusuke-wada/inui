import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { errorMessage, fetchJson } from '@inui/feature-kit/web';
import { Feedback, Loading, useLatestRequest } from '@inui/feature-kit/react';
import { MAX_NAME_LENGTH, parseBoard, parseBoardSummary, parseBoards } from './client.ts';
import type { Board, BoardScene, BoardSummary } from './client.ts';

// Excalidrawのフォントとスタイルは、アプリが配信する /excalidraw/ から読む（外部のCDNを使わない）。
// Canvasの読み込みより前に設定する必要があるため、Excalidrawを読むモジュールとは分けている。
const ASSET_PATH = '/excalidraw/';
declare global { interface Window { EXCALIDRAW_ASSET_PATH?: string | string[] } }
window.EXCALIDRAW_ASSET_PATH = ASSET_PATH;
const Canvas = lazy(() => import('./Canvas.tsx'));

let styles: Promise<void> | undefined;
/** ExcalidrawのCSSはホワイトボードを開いたときだけ読み込む。 */
function loadStyles(): Promise<void> {
  styles ??= new Promise<void>((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = ASSET_PATH + 'index.css';
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => { styles = undefined; link.remove(); reject(new Error('styles')); }, { once: true });
    document.head.append(link);
  });
  return styles;
}

/** 使われている画像だけを保存し、削除した画像のデータを残さない。 */
function currentScene(api: ExcalidrawImperativeAPI): BoardScene {
  // Excalidrawの型定義ではAPIの戻り値の型が解決されないため、公開されている要素の型を明示する。
  const elements: readonly NonDeletedExcalidrawElement[] = api.getSceneElements();
  const used = new Set<string>(elements.flatMap((element) => element.type === 'image' && element.fileId ? [element.fileId] : []));
  const allFiles: BinaryFiles = api.getFiles();
  const files = Object.fromEntries(Object.entries(allFiles).filter(([id]) => used.has(id)));
  return { elements: [...elements], files, appState: { viewBackgroundColor: api.getAppState().viewBackgroundColor } };
}

export default function Whiteboard() {
  const [boards, setBoards] = useState<BoardSummary[]>();
  const [board, setBoard] = useState<Board>();
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');
  const [stylesReady, setStylesReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  // 保存した（または開いた）時点の要素の版と、現在の版。差があれば未保存の変更がある。
  const savedVersion = useRef<number | undefined>(undefined);
  const latestVersion = useRef<number | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const listRequests = useLatestRequest();
  const boardRequests = useLatestRequest();

  useEffect(() => {
    loadStyles().then(() => setStylesReady(true), () => setError('ホワイトボードの表示に必要なファイルを読み込めませんでした。'));
  }, []);

  const loadList = useCallback(async () => {
    const request = listRequests.begin();
    try {
      const rows = parseBoards(await fetchJson('/api/whiteboards', { signal: request.signal }));
      if (request.isCurrent()) setBoards(rows);
    } catch (failure) {
      if (request.isCurrent()) setError(errorMessage(failure, 'ボードの一覧の取得'));
    }
  }, [listRequests]);
  useEffect(() => { void loadList(); }, [loadList]);

  // 未保存の変更があるときは、画面を閉じる前に確認する。
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function confirmDiscard(): boolean {
    return !dirty || window.confirm('保存していない変更があります。破棄して続けますか？');
  }

  async function open(id: string, { confirmed = false } = {}) {
    if (busyRef.current || (!confirmed && !confirmDiscard())) return;
    const request = boardRequests.begin();
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const data = parseBoard(await fetchJson('/api/whiteboards/' + id, { signal: request.signal }), id);
      if (!request.isCurrent()) return;
      api.current = null;
      savedVersion.current = undefined;
      latestVersion.current = undefined;
      setDirty(false);
      setBoard(data);
      setName(data.name);
    } catch (failure) {
      if (request.isCurrent()) setError(errorMessage(failure, 'ボードの読み込み'));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }

  /** 書き込みは1件ずつ行い、同じ描画の間に届いた2回目の操作も止める。 */
  async function write<T>(action: () => Promise<T>, label: string): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      return await action();
    } catch (failure) {
      setError(errorMessage(failure, label));
      return undefined;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH || !confirmDiscard()) return;
    void write(async () => {
      const created = parseBoardSummary(await fetchJson('/api/whiteboards', { method: 'POST', body: { name: trimmed } }));
      setNewName('');
      await loadList();
      return created.id;
    }, 'ボードの作成').then((id) => { if (id) void open(id, { confirmed: true }); });
  }

  function save() {
    const current = board;
    const trimmed = name.trim();
    if (!current || !api.current || !trimmed || trimmed.length > MAX_NAME_LENGTH) return;
    const scene = currentScene(api.current);
    const version = latestVersion.current;
    void write(async () => {
      parseBoardSummary(await fetchJson('/api/whiteboards/' + current.id, {
        method: 'PATCH', body: { name: trimmed, scene }, timeoutMs: 60_000,
      }));
      // 保存中に描き足した分は、未保存のまま残す。
      savedVersion.current = version;
      setDirty(latestVersion.current !== version);
      setNotice('保存しました。');
      await loadList();
    }, 'ボードの保存');
  }

  function remove(target: BoardSummary) {
    if (!window.confirm(`「${target.name}」を削除しますか？元に戻せません。`)) return;
    void write(async () => {
      await fetchJson('/api/whiteboards/' + target.id, { method: 'DELETE' });
      if (board?.id === target.id) { setBoard(undefined); setDirty(false); api.current = null; }
      await loadList();
    }, 'ボードの削除');
  }

  const onVersion = useCallback((version: number) => {
    latestVersion.current = version;
    // 最初の描画で読み込んだ時点の版を基準にし、その後の変化を未保存として扱う。
    if (savedVersion.current === undefined) { savedVersion.current = version; return; }
    setDirty(version !== savedVersion.current);
  }, []);
  const onReady = useCallback((instance: ExcalidrawImperativeAPI) => { api.current = instance; }, []);

  return <div className="panel whiteboard-panel">
    <div className="panel-heading"><p className="eyebrow">WHITEBOARD</p><h2>ホワイトボード</h2>
      <p>手書きで絵や図を描けます。描いた内容は「保存」を押したときだけ保存します。画像の書き出しは左上のメニューから行えます。</p></div>
    <div className="whiteboard-layout">
      <aside className="whiteboard-list" aria-label="ボードの一覧">
        <form className="task-add" onSubmit={create}>
          <label className="visually-hidden" htmlFor="board-name-new">新しいボードの名前</label>
          <input id="board-name-new" type="text" maxLength={MAX_NAME_LENGTH} value={newName} placeholder="例：設計のラフ"
            disabled={busy} onChange={(event) => setNewName(event.target.value)} />
          <button className="button button-primary" type="submit" disabled={busy || !newName.trim()}>作成</button>
        </form>
        {!boards && !error && <Loading message="ボードを読み込んでいます…" />}
        {boards?.length === 0 && <div className="empty-state" role="status"><p>ボードはまだありません。</p><span>名前を入力して「作成」を押してください。</span></div>}
        {boards && boards.length > 0 && <ul className="task-list">
          {boards.map((item) => <li key={item.id} className={'task-item board-item' + (item.id === board?.id ? ' board-current' : '')}>
            <button className="board-open" type="button" disabled={busy || loading} aria-current={item.id === board?.id || undefined}
              onClick={() => { void open(item.id); }}>{item.name}</button>
            <button className="text-button" type="button" disabled={busy} aria-label={`「${item.name}」を削除`}
              onClick={() => remove(item)}>削除</button>
          </li>)}
        </ul>}
      </aside>
      <section className="whiteboard-main" aria-label="描画">
        {error && <Feedback message={error} />}
        {notice && <div className="feedback feedback-success" role="status">{notice}</div>}
        {loading && <Loading message="ボードを開いています…" />}
        {!board && !loading && <div className="empty-state" role="status"><p>一覧からボードを選ぶか、新しく作成してください。</p></div>}
        {board && <>
          <div className="whiteboard-toolbar">
            <label className="visually-hidden" htmlFor="board-name">ボードの名前</label>
            <input id="board-name" type="text" maxLength={MAX_NAME_LENGTH} value={name} disabled={busy}
              onChange={(event) => { setName(event.target.value); setDirty(true); }} />
            <button className="button button-primary" type="button" disabled={busy || !name.trim() || !stylesReady} onClick={save}>
              {busy ? '保存しています…' : '保存'}
            </button>
            <span className="whiteboard-state" role="status">{dirty ? '未保存の変更があります' : '保存済み'}</span>
          </div>
          <div className="whiteboard-canvas">
            {stylesReady && <Suspense fallback={<Loading message="ホワイトボードを読み込んでいます…" />}>
              <Canvas key={board.id} scene={board.scene} onReady={onReady} onVersion={onVersion} />
            </Suspense>}
          </div>
        </>}
      </section>
    </div>
  </div>;
}
