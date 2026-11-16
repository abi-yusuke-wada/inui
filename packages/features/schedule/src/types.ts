export interface Employee { id: string; name: string }
export interface ScheduleEvent { id: string; personId: string; title: string; start: string; end: string }
export interface PeopleSelection {
  selectedIds: string[];
  ambiguous: { name: string; candidateIds: string[] }[];
  unknownNames: string[];
}
export type ScheduleResult = { date: string; employees: Employee[]; events: ScheduleEvent[] };
