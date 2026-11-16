import { useCallback, useEffect, useState } from 'react';
import { ApiError, errorMessage, fetchJson, validDate } from '@inui/feature-kit/web';
import { Feedback, useLatestRequest } from '@inui/feature-kit/react';
import { parseEmployees, parseSchedules } from './client.ts';
import type { Employee, PeopleSelection, ScheduleResult } from './types.ts';

const EMPTY_PEOPLE: PeopleSelection = { selectedIds: [], ambiguous: [], unknownNames: [] };
const DEFAULT_SCHEDULE_DATE = '2026-11-02';

export default function Schedules({ people = EMPTY_PEOPLE }: { people?: PeopleSelection | undefined }) {
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
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: 横スクロールをキーボードで操作できるよう、領域へのフォーカスを許可する。 */}
      <section className="schedule-scroll" tabIndex={0} aria-label="社員ごとの予定">
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
      </section>
    </section>}
  </div>;
}
