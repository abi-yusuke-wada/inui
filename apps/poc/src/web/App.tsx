import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Application, Employee, PeopleSelection } from '../types.ts';
import {
  ApiError, LatestRequest, errorMessage, fetchJson, parseApplications, parseDecision,
  parseEmployees, parseSavedApplication, parseSchedules, validDate,
} from './api.ts';
import type { Notice, ScheduleResult, Screen } from './api.ts';

const NOTICE_TITLES: Record<Notice, string> = {
  unsupported_feature: 'この機能はまだ利用できません',
  unsupported_operation: 'この操作には対応していません',
  clarify: 'もう少し詳しく教えてください',
};
const NOTICE_MESSAGES: Record<Notice, string> = {
  unsupported_feature: '休暇申請・交通費精算・申請状況の確認・予定比較をご利用いただけます。',
  unsupported_operation: '申請の取り下げ・修正・承認は、この画面では行えません。',
  clarify: 'どの申請や確認をしたいか、用件を添えて入力してください。',
};
const STATUS_NAMES = { pending: '申請中', approved: '承認済み', returned: '差し戻し' } as const;
const PERIOD_NAMES = { full_day: '全日', am: '午前半休', pm: '午後半休' } as const;
const EMPTY_PEOPLE: PeopleSelection = { selectedIds: [], ambiguous: [], unknownNames: [] };
const DEFAULT_SCHEDULE_DATE = '2026-11-02';
type View =
  | { kind: 'empty' }
  | { kind: 'notice'; intent: Notice; message: string }
  | { kind: 'screen'; screen: Screen; instance: number; people?: PeopleSelection };

function useLatestRequest() {
  const [gate] = useState(() => new LatestRequest());
  useEffect(() => () => gate.cancel(), [gate]);
  return gate;
}

function Feedback({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <div className="feedback feedback-error" role="alert">
    <p>{message}</p>
    {onRetry && <button className="button button-subtle" type="button" onClick={onRetry}>もう一度試す</button>}
  </div>;
}

export function App() {
  const legacy = window.location.pathname.replace(/\/$/, '') === '/legacy';
  const [text, setText] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: 'empty' });
  const [routing, setRouting] = useState(false);
  const [routingError, setRoutingError] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const saveBusyRef = useRef(false);
  const [announcement, setAnnouncement] = useState('');
  const [category, setCategory] = useState<'apply' | 'lookup' | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const resultRegion = useRef<HTMLElement>(null);
  const instance = useRef(0);
  const routeRequest = useLatestRequest();
  const reportSaving = useCallback((busy: boolean) => {
    saveBusyRef.current = busy;
    setSaveBusy(busy);
  }, []);

  useEffect(() => {
    if (view.kind !== 'empty') resultRegion.current?.focus();
  }, [view]);

  function showScreen(screen: Screen, people?: PeopleSelection) {
    if (saveBusyRef.current) return;
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
    if (!submitted || submitted.length > 2000 || saveBusyRef.current) return;
    const request = routeRequest.begin();
    setRouting(true);
    setRoutingError('');
    setAnnouncement('');
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

  function saved(application: Application) {
    reportSaving(false);
    setAnnouncement((application.type === 'leave' ? '休暇申請' : '交通費精算') + 'を受け付けました。申請一覧でご確認ください。');
    showScreen('application_status');
  }

  function resetMenu() {
    if (saveBusyRef.current) return;
    routeRequest.cancel();
    setView({ kind: 'empty' });
    setCategory(null);
    setAnnouncement('');
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
      {!legacy && <section className={'composer ' + (view.kind === 'empty' ? 'composer-intro' : '')} aria-label="用件を入力">
        <p className="eyebrow">YOUR INTENT, YOUR UI</p>
        <h1>{view.kind === 'empty' ? '今日は、何をしますか？' : 'ほかに、したいことはありますか？'}</h1>
        <p className="intro-copy">用件をひとことで。必要な画面を開きます。</p>
        <form className="intent-form" onSubmit={(event) => { event.preventDefault(); void route(); }}>
          <label className="visually-hidden" htmlFor="intent-text">したいこと</label>
          <textarea id="intent-text" ref={input} rows={2} maxLength={2000} value={text}
            placeholder="例：有給を取りたい"
            disabled={saveBusy}
            onChange={(event) => {
              routeRequest.cancel();
              setRouting(false);
              setRoutingError('');
              setText(event.target.value);
            }} />
          <button className="button button-primary intent-submit" type="submit"
            disabled={!text.trim() || saveBusy || routing}>
            {routing ? '確認しています…' : '画面を開く'}<span aria-hidden="true">↗</span>
          </button>
        </form>
        <p className="input-hint">キーボードでも、お使いの音声入力でも。</p>
        {helpOpen && <div className="help-panel" id="help">
          <p>したいことを入力して「画面を開く」を押してください。申請は、表示されたフォームで内容を入力して確定します。</p>
          <div className="example-list">
            {['有給を取りたい', '交通費を精算したい', '申請の状況を見たい', '山田太郎さんと佐藤花子さんの予定を比較したい'].map((example) =>
              <button type="button" key={example} disabled={saveBusy} onClick={() => {
                routeRequest.cancel(); setRouting(false); setRoutingError(''); setText(example); input.current?.focus();
              }}>{example}<span aria-hidden="true">↗</span></button>)}
          </div>
          <a href="/legacy">比較用のメニューから探す</a>
        </div>}
        {routing && <p className="loading-line" role="status"><span className="loading-dot" />入力を確認しています…</p>}
        {routingError && <Feedback message={routingError} onRetry={() => { void route(); }} />}
      </section>}

      {legacy && <section className="legacy-intro">
        <p className="eyebrow">MENU</p>
        <h1>メニューから探す</h1>
        <p className="intro-copy">分類を選び、申請・確認する画面を開きます。</p>
        {view.kind !== 'empty' && <button className="text-button" type="button" disabled={saveBusy} onClick={resetMenu}>← メニューに戻る</button>}
        {view.kind === 'empty' && <nav className="legacy-menu" aria-label="業務メニュー">
          {category === null ? <>
            <button type="button" onClick={() => setCategory('apply')}>申請する<span aria-hidden="true">→</span></button>
            <button type="button" onClick={() => setCategory('lookup')}>確認する<span aria-hidden="true">→</span></button>
          </> : <>
            <button className="menu-back" type="button" onClick={() => setCategory(null)}>← 分類に戻る</button>
            {(category === 'apply'
              ? [['leave_request', '休暇申請'], ['expense_request', '交通費精算'], ['unsupported_feature', '出張申請'], ['unsupported_feature', '備品購入申請']]
              : [['application_status', '申請状況'], ['schedule_compare', '予定比較'], ['unsupported_feature', '会議室予約']]).map(([intent, label]) =>
              <button type="button" key={label} onClick={() => intent === 'unsupported_feature'
                ? showNotice('unsupported_feature') : showScreen(intent as Screen)}>
                {label}<span aria-hidden="true">→</span>
              </button>)}
          </>}
        </nav>}
      </section>}

      {announcement && <div className="feedback feedback-success" role="status">{announcement}</div>}
      <section ref={resultRegion} className="result-region" tabIndex={-1} aria-label="用件に応じた画面">
        {view.kind === 'notice' && <div className="panel notice-panel">
          <span className="notice-symbol" aria-hidden="true">i</span>
          <h2>{NOTICE_TITLES[view.intent]}</h2>
          <p>{view.message}</p>
          <button type="button" className="button button-subtle" onClick={() => legacy ? resetMenu() : input.current?.focus()}>
            {legacy ? 'メニューへ戻る' : '入力を直す'}
          </button>
        </div>}
        {view.kind === 'screen' && <>
          {(view.screen === 'leave_request' || view.screen === 'expense_request') &&
            <ApplicationForm key={view.instance} type={view.screen === 'leave_request' ? 'leave' : 'expense'}
              navigating={routing} onSaving={reportSaving} onSaved={saved}
              onShowApplications={() => showScreen('application_status')} />}
          {view.screen === 'application_status' && <Applications key={view.instance} />}
          {view.screen === 'schedule_compare' && <Schedules key={view.instance} people={view.people} />}
        </>}
      </section>
    </main>
    <footer className="site-footer">inui<span aria-hidden="true"> · </span>仕事の入口を、もっと自然に。</footer>
  </div>;
}

function ApplicationForm({ type, navigating, onSaving, onSaved, onShowApplications }: {
  type: 'leave' | 'expense';
  navigating: boolean;
  onSaving: (busy: boolean) => void;
  onSaved: (application: Application) => void;
  onShowApplications: () => void;
}) {
  const [date, setDate] = useState('');
  const [period, setPeriod] = useState<'full_day' | 'am' | 'pm'>('full_day');
  const [amount, setAmount] = useState('');
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  const requests = useLatestRequest();
  const leave = type === 'leave';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving.current || uncertain || navigating) return;
    if (!validDate(date) || (!leave && (!Number.isSafeInteger(Number(amount)) || Number(amount) < 1))) {
      setError(leave ? '実在する取得日を入力してください。' : '実在する利用日と、1円以上の整数の金額を入力してください。');
      return;
    }
    const request = requests.begin();
    saving.current = true;
    setBusy(true);
    setError('');
    onSaving(true);
    try {
      const body = leave
        ? { date, period, ...(detail.trim() ? { reason: detail.trim() } : {}) }
        : { date, amount: Number(amount), ...(detail.trim() ? { description: detail.trim() } : {}) };
      const application = parseSavedApplication(await fetchJson('/api/applications/' + type, {
        method: 'POST', body, signal: request.signal,
      }));
      if (!request.isCurrent()) return;
      if (application.type !== type) throw new ApiError('invalid');
      onSaved(application);
    } catch (failure) {
      if (!request.isCurrent()) return;
      const knownFailure = failure instanceof ApiError && failure.kind === 'http'
        && failure.status !== undefined && failure.status >= 400 && failure.status < 500;
      if (knownFailure) setError(errorMessage(failure, '申請'));
      else {
        setUncertain(true);
        setError('保存結果を確認できませんでした。保存済みの可能性があるため、再送せず申請一覧で確認してください。');
      }
    } finally {
      saving.current = false;
      if (request.isCurrent()) setBusy(false);
      onSaving(false);
    }
  }

  return <div className="panel form-panel">
    <div className="panel-heading"><p className="eyebrow">APPLICATION</p><h2>{leave ? '休暇申請' : '交通費精算'}</h2>
      <p>内容を確認して、申請を確定してください。</p></div>
    <form onSubmit={(event) => { void submit(event); }}>
      <fieldset disabled={busy || uncertain || navigating} className="form-fields">
        <div className="field">
          <label htmlFor="application-date">{leave ? '取得日' : '利用日'}<span className="required-tag">必須</span></label>
          <input id="application-date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        {leave ? <div className="field">
          <label htmlFor="application-period">区分</label>
          <select id="application-period" value={period} onChange={(event) => setPeriod(event.target.value as typeof period)}>
            <option value="full_day">全日</option><option value="am">午前半休</option><option value="pm">午後半休</option>
          </select>
        </div> : <div className="field">
          <label htmlFor="application-amount">金額<span className="required-tag">必須</span></label>
          <div className="amount-field"><input id="application-amount" type="number" inputMode="numeric"
            min="1" step="1" required value={amount} onChange={(event) => setAmount(event.target.value)} /><span>円</span></div>
        </div>}
        <div className="field field-wide">
          <label htmlFor="application-detail">{leave ? '理由' : '内容'}<span className="optional-tag">任意</span></label>
          <textarea id="application-detail" rows={3} maxLength={500} value={detail} onChange={(event) => setDetail(event.target.value)} />
        </div>
      </fieldset>
      {error && <Feedback message={error} />}
      <div className="form-actions">
        {uncertain ? <button className="button button-primary" type="button" onClick={onShowApplications}>申請一覧で確認する</button>
          : <button className="button button-primary" type="submit" disabled={busy || navigating}>{busy ? '保存しています…' : 'この内容で申請する'}</button>}
        <p>{busy ? '完了するまでお待ちください。' : 'ボタンを押すまで、申請は保存されません。'}</p>
      </div>
    </form>
  </div>;
}

function Applications() {
  const [status, setStatus] = useState('all');
  const [applications, setApplications] = useState<Application[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requests = useLatestRequest();
  const load = useCallback(async () => {
    const request = requests.begin();
    setLoading(true);
    setError('');
    setApplications(undefined);
    try {
      const rows = parseApplications(await fetchJson('/api/applications' + (status === 'all' ? '' : '?status=' + status), { signal: request.signal }));
      if (request.isCurrent()) setApplications(rows);
    } catch (failure) {
      if (request.isCurrent()) setError(errorMessage(failure, '申請一覧の取得'));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [requests, status]);
  useEffect(() => { void load(); }, [load]);

  return <div className="panel list-panel">
    <div className="panel-heading"><p className="eyebrow">MY APPLICATIONS</p><h2>申請一覧</h2><p>自分が提出した申請を確認できます。</p></div>
    <div className="list-toolbar">
      <div className="field"><label htmlFor="application-status">状態で絞り込む</label>
        <select id="application-status" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="all">すべて</option><option value="pending">申請中</option>
          <option value="approved">承認済み</option><option value="returned">差し戻し</option>
        </select></div>
      <button type="button" className="text-button" disabled={loading} onClick={() => { void load(); }}>再読み込み</button>
    </div>
    {loading && <p className="loading-line" role="status"><span className="loading-dot" />申請を読み込んでいます…</p>}
    {error && <Feedback message={error} onRetry={() => { void load(); }} />}
    {applications && (applications.length === 0
      ? <div className="empty-state" role="status"><p>該当する申請はありません。</p><span>別の状態を選ぶと、表示を切り替えられます。</span></div>
      : <><p className="result-count" role="status">{applications.length}件の申請</p>
        <div className="table-scroll" role="region" aria-label="申請の一覧" tabIndex={0}>
          <table><thead><tr><th scope="col">申請日</th><th scope="col">種類</th><th scope="col">内容</th><th scope="col">状態</th></tr></thead>
            <tbody>{applications.map((application) => <tr key={application.id}>
              <td className="date-cell">{application.submittedOn.replaceAll('-', '/')}</td>
              <td>{application.type === 'leave' ? '休暇申請' : '交通費精算'}</td>
              <td>{application.date.replaceAll('-', '/')} {application.type === 'leave'
                ? PERIOD_NAMES[application.period ?? 'full_day']
                : (application.description || '交通費') + ' ' + application.amount?.toLocaleString('ja-JP') + '円'}
                {application.type === 'leave' && application.reason && <small className="application-detail">{application.reason}</small>}</td>
              <td><span className={'status-pill status-' + application.status}>{STATUS_NAMES[application.status]}</span></td>
            </tr>)}</tbody></table>
        </div></>)}
  </div>;
}

function Schedules({ people = EMPTY_PEOPLE }: { people?: PeopleSelection | undefined }) {
  const [employees, setEmployees] = useState<Employee[]>();
  const [selected, setSelected] = useState<string[]>(people.selectedIds);
  const [date, setDate] = useState(DEFAULT_SCHEDULE_DATE);
  const [employeeLoading, setEmployeeLoading] = useState(false);
  const [employeeError, setEmployeeError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScheduleResult>();
  const [namesReviewed, setNamesReviewed] = useState(false);
  const employeeRequests = useLatestRequest();
  const scheduleRequests = useLatestRequest();

  const loadSchedules = useCallback(async (ids: string[], day: string) => {
    if (ids.length < 2 || !validDate(day)) return;
    const request = scheduleRequests.begin();
    setLoading(true);
    setError('');
    setResult(undefined);
    try {
      const query = new URLSearchParams({ date: day, personIds: ids.join(',') });
      const data = parseSchedules(await fetchJson('/api/schedules?' + query.toString(), { signal: request.signal }), day, ids);
      if (request.isCurrent()) setResult(data);
    } catch (failure) {
      if (request.isCurrent()) setError(errorMessage(failure, '予定の取得'));
    } finally {
      if (request.isCurrent()) setLoading(false);
    }
  }, [scheduleRequests]);

  const loadEmployees = useCallback(async () => {
    const request = employeeRequests.begin();
    setEmployeeLoading(true);
    setEmployeeError('');
    try {
      const data = parseEmployees(await fetchJson('/api/employees', { signal: request.signal }));
      if (!request.isCurrent()) return;
      const knownIds = new Set(data.map((employee) => employee.id));
      if (!people.selectedIds.every((id) => knownIds.has(id))
          || !people.ambiguous.every((item) => item.candidateIds.every((id) => knownIds.has(id)))) {
        throw new ApiError('invalid');
      }
      setEmployees(data);
      const ids = [...people.selectedIds];
      setSelected(ids);
      if (ids.length >= 2 && people.ambiguous.length === 0 && people.unknownNames.length === 0) {
        void loadSchedules(ids, DEFAULT_SCHEDULE_DATE);
      }
    } catch (failure) {
      if (request.isCurrent()) setEmployeeError(errorMessage(failure, '社員情報の取得'));
    } finally {
      if (request.isCurrent()) setEmployeeLoading(false);
    }
  }, [employeeRequests, people, loadSchedules]);
  useEffect(() => { void loadEmployees(); }, [loadEmployees]);

  function invalidateResult() {
    scheduleRequests.cancel();
    setLoading(false);
    setError('');
    setResult(undefined);
  }
  const needsNameReview = !namesReviewed && (people.ambiguous.length > 0 || people.unknownNames.length > 0);

  return <div className="panel schedule-panel">
    <div className="panel-heading"><p className="eyebrow">SCHEDULES</p><h2>予定比較</h2><p>社員の予定を、同じ日付で並べて確認できます。</p></div>
    {needsNameReview && <div className="feedback feedback-info" role="status">
      {people.ambiguous.map((item) => <p key={item.name}>「{item.name}」に当てはまる社員が複数います。確認する社員を選んでください。</p>)}
      {people.unknownNames.length > 0 && <p>「{people.unknownNames.join('、')}」に当てはまる社員が見つかりませんでした。社員の一覧から選び直してください。</p>}
    </div>}
    {employeeLoading && <p className="loading-line" role="status"><span className="loading-dot" />社員を読み込んでいます…</p>}
    {employeeError && <Feedback message={employeeError} onRetry={() => { void loadEmployees(); }} />}
    <form className="schedule-controls" onSubmit={(event) => {
      event.preventDefault();
      setNamesReviewed(true);
      void loadSchedules(selected, date);
    }}>
      <fieldset className="employee-picker" disabled={employeeLoading || !employees}>
        <legend>比較する社員<span className="optional-tag">2名以上</span></legend>
        <div className="employee-options">
          {employees?.map((employee) => <label className={'employee-option ' + (selected.includes(employee.id) ? 'selected' : '')} key={employee.id}>
            <input type="checkbox" checked={selected.includes(employee.id)} onChange={(event) => {
              const checked = event.target.checked;
              invalidateResult();
              setSelected((current) => checked ? [...current, employee.id] : current.filter((id) => id !== employee.id));
            }} />
            {employee.name}
          </label>)}
        </div>
        {employees?.length === 0 && <p>表示できる社員がいません。</p>}
      </fieldset>
      <div className="schedule-date-row">
        <div className="field"><label htmlFor="schedule-date">予定日</label>
          <input id="schedule-date" type="date" required value={date} disabled={employeeLoading || !employees}
            onChange={(event) => { invalidateResult(); setDate(event.target.value); }} /></div>
        <button className="button button-primary" type="submit"
          disabled={employeeLoading || !employees || selected.length < 2 || !validDate(date) || loading}>{loading ? '読み込んでいます…' : '予定を表示'}</button>
      </div>
      <p className="input-hint">予定日はここで切り替えられます。社員と日付を変更したら「予定を表示」を押してください。</p>
    </form>
    {loading && <p className="loading-line" role="status"><span className="loading-dot" />予定を読み込んでいます…</p>}
    {error && <Feedback message={error} onRetry={() => { void loadSchedules(selected, date); }} />}
    {!loading && !error && !result && employees && <div className="empty-state" role="status">
      <p>{selected.length < 2 ? '比較する社員を2名以上選んでください。' : '社員と日付を確認して、予定を表示してください。'}</p>
    </div>}
    {result && <section className="schedule-results" aria-label="予定の比較結果">
      <h3>{result.date.replaceAll('-', '/')}の予定</h3>
      <div className="schedule-scroll" tabIndex={0} role="region" aria-label="社員ごとの予定">
        <div className="schedule-columns">
          {result.employees.map((employee) => {
            const events = result.events.filter((event) => event.personId === employee.id)
              .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
            return <section className="person-schedule" key={employee.id} aria-label={employee.name + 'の予定'}>
              <h4>{employee.name}</h4>
              {events.length === 0 ? <p className="no-events">この日の予定はありません。</p>
                : <ul>{events.map((event) => <li className="schedule-event" key={event.id}>
                  <p className="event-time"><time>{event.start}</time><span aria-hidden="true">–</span><span className="visually-hidden">から</span><time>{event.end}</time></p>
                  <p>{event.title}</p>
                </li>)}</ul>}
            </section>;
          })}
        </div>
      </div>
    </section>}
  </div>;
}
