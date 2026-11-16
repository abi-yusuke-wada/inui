import { Hono } from 'hono';
import { checkQuery, invalidInput, isValidDate } from '@inui/feature-kit/server';
import { DEFAULT_DATE, listEmployees, listSchedules } from './people.ts';

export { listEmployees, selectPeople } from './people.ts';

/** 社員と予定の参照だけを提供する。予定の登録・削除は行わない。 */
export function createScheduleRoutes(): Hono {
  const routes = new Hono();

  routes.get('/employees', (c) => {
    if (new URL(c.req.url).search) invalidInput();
    return c.json({ employees: listEmployees() });
  });

  routes.get('/schedules', (c) => {
    const query = checkQuery(c, ['date', 'personIds']);
    const date = query.get('date') ?? DEFAULT_DATE;
    const rawIds = query.get('personIds');
    const ids = rawIds ? rawIds.split(',') : [];
    const known = new Set(listEmployees().map((person) => person.id));
    if (!isValidDate(date) || ids.length > known.size || new Set(ids).size !== ids.length
        || ids.some((id) => !known.has(id))) invalidInput();
    return c.json(listSchedules(date, ids));
  });

  return routes;
}
