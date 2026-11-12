export type ApplicationStatus = 'pending' | 'approved' | 'returned';
export type LeavePeriod = 'full_day' | 'am' | 'pm';

export interface Application {
  id: string;
  type: 'leave' | 'expense';
  submittedOn: string;
  date: string;
  status: ApplicationStatus;
  period?: LeavePeriod;
  reason?: string;
  amount?: number;
  description?: string;
}

export interface LeaveInput { date: string; period: LeavePeriod; reason?: string }
export interface ExpenseInput { date: string; amount: number; description?: string }
export interface Employee { id: string; name: string }
export interface ScheduleEvent { id: string; personId: string; title: string; start: string; end: string }
export interface PeopleSelection {
  selectedIds: string[];
  ambiguous: { name: string; candidateIds: string[] }[];
  unknownNames: string[];
}
