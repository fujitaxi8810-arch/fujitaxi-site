import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export type EmpType = 'fulltime' | 'fulltime-base' | 'fulltime-hourly' | 'part' | 'monthly';

export type Staff = {
  id: string;
  name: string;
  displayOrder: number;
  type: EmpType;
  hourlyWage: number | null;
  monthlyWage: number | null;
  dailyWage: number | null;
  commuteAllowance: number;
  phoneDutyDisabled: boolean;
  lateShiftDisabled: boolean;
  shiftShuttle: boolean;
  shiftSpecial: boolean;
  shiftGroup: 'office' | 'jumbo' | null;
};

export type Payments = Record<string, number>;

export type Attendance = {
  id: string;
  staffId: string;
  date: string; // 'YYYY-MM-DD'
  in: string | null; // ISO
  out: string | null; // ISO
  shiftType: 'normal' | 'late' | 'part' | null;
  phoneDuty: boolean;
  breaks: { start: string; end: string | null }[];
  leaves: { start: string; end: string | null }[];
  empType: EmpType | null;
  hourlyWage: number | null;
  monthlyWage: number | null;
  dailyWage: number | null;
  commute: number | null;
  salesGross: number | null;
  sales: number | null;
  uncollected: number | null;
  cardFee: number | null;
  payments: Payments;
};

export type Settings = {
  normalWage: number;
  lateWage: number;
  lateBonus: number;
  phoneAllowance: number;
  commissionRate: number;
  minWage: number;
  feeRates: Record<string, number>;
};

// ── 認証 ──
const KIOSK_CRED_KEY = 'fuji-kintai-kiosk-cred';

function getStoredKioskCred(): { email: string; password: string } | null {
  try {
    const raw = localStorage.getItem(KIOSK_CRED_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 端末にkioskセッションが無ければ、初回のみメール/パスワードを入力してもらいログイン。
 * 以降はSupabaseのセッション永続化により自動ログイン状態を維持する。
 */
export async function ensureKioskSession(): Promise<{ ok: boolean; error?: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) return { ok: true };

  let cred = getStoredKioskCred();
  if (!cred) {
    const email = prompt('この端末の勤怠アプリ用ログイン情報を入力してください（初回のみ）\nメールアドレス（例: kiosk@fujitaxi.local）');
    if (!email) return { ok: false, error: 'ログインがキャンセルされました。' };
    const password = prompt('パスワード');
    if (!password) return { ok: false, error: 'ログインがキャンセルされました。' };
    cred = { email: email.trim(), password };
  }

  const { error } = await supabase.auth.signInWithPassword(cred);
  if (error) {
    localStorage.removeItem(KIOSK_CRED_KEY);
    return { ok: false, error: `ログインに失敗しました：${error.message}` };
  }
  localStorage.setItem(KIOSK_CRED_KEY, JSON.stringify(cred));
  return { ok: true };
}

let cachedIsAdmin = false;

export function isAdmin(): boolean {
  return cachedIsAdmin;
}

async function refreshAdminFlag(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const role = data.session?.user?.app_metadata?.role;
  cachedIsAdmin = role === 'admin';
}

export async function initAuth(): Promise<{ ok: boolean; error?: string }> {
  const result = await ensureKioskSession();
  if (result.ok) await refreshAdminFlag();
  return result;
}

export async function signInAdmin(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) return { ok: false, error: error?.message || '認証に失敗しました。' };
  if (data.session.user.app_metadata?.role !== 'admin') {
    // 管理者ロールが無いアカウントでログインした場合はkioskに戻す
    await signOutToKiosk();
    return { ok: false, error: 'このアカウントには管理者権限がありません。' };
  }
  cachedIsAdmin = true;
  return { ok: true };
}

export async function signOutToKiosk(): Promise<void> {
  await supabase.auth.signOut();
  cachedIsAdmin = false;
  await ensureKioskSession();
  await refreshAdminFlag();
}

// ── staff ──
function rowToStaff(row: any): Staff {
  return {
    id: row.id,
    name: row.name,
    displayOrder: row.display_order,
    type: row.emp_type,
    hourlyWage: row.hourly_wage,
    monthlyWage: row.monthly_wage,
    dailyWage: row.daily_wage,
    commuteAllowance: row.commute_allowance,
    phoneDutyDisabled: row.phone_duty_disabled,
    lateShiftDisabled: row.late_shift_disabled,
    shiftShuttle: row.shift_shuttle,
    shiftSpecial: row.shift_special,
    shiftGroup: row.shift_group,
  };
}

export async function fetchStaff(): Promise<Staff[]> {
  const { data, error } = await supabase
    .from('staff')
    .select('*')
    .eq('is_active', true)
    .order('display_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToStaff);
}

export async function insertStaff(input: {
  name: string;
  type: EmpType;
  hourlyWage?: number | null;
  monthlyWage?: number | null;
  dailyWage?: number | null;
  commuteAllowance?: number;
}): Promise<Staff> {
  const { data: maxRow } = await supabase
    .from('staff')
    .select('display_order')
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = (maxRow?.display_order ?? 0) + 1;
  const { data, error } = await supabase
    .from('staff')
    .insert({
      name: input.name,
      display_order: nextOrder,
      emp_type: input.type,
      hourly_wage: input.hourlyWage ?? null,
      monthly_wage: input.monthlyWage ?? null,
      daily_wage: input.dailyWage ?? null,
      commute_allowance: input.commuteAllowance ?? 0,
    })
    .select()
    .single();
  if (error) throw error;
  return rowToStaff(data);
}

export async function updateStaff(id: string, patch: Partial<{
  type: EmpType;
  hourlyWage: number | null;
  monthlyWage: number | null;
  dailyWage: number | null;
  commuteAllowance: number;
}>): Promise<void> {
  const dbPatch: Record<string, unknown> = {};
  if (patch.type !== undefined) dbPatch.emp_type = patch.type;
  if (patch.hourlyWage !== undefined) dbPatch.hourly_wage = patch.hourlyWage;
  if (patch.monthlyWage !== undefined) dbPatch.monthly_wage = patch.monthlyWage;
  if (patch.dailyWage !== undefined) dbPatch.daily_wage = patch.dailyWage;
  if (patch.commuteAllowance !== undefined) dbPatch.commute_allowance = patch.commuteAllowance;
  const { error } = await supabase.from('staff').update(dbPatch).eq('id', id);
  if (error) throw error;
}

export async function deactivateStaff(id: string): Promise<void> {
  const { error } = await supabase.from('staff').update({ is_active: false }).eq('id', id);
  if (error) throw error;
}

// ── settings ──
export async function fetchSettings(): Promise<Settings> {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return {
    normalWage: data.normal_wage,
    lateWage: data.late_wage,
    lateBonus: data.late_bonus,
    phoneAllowance: data.phone_allowance,
    commissionRate: Number(data.commission_rate),
    minWage: data.min_wage,
    feeRates: data.fee_rates,
  };
}

export async function updateSettings(s: Settings): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .update({
      normal_wage: s.normalWage,
      late_wage: s.lateWage,
      late_bonus: s.lateBonus,
      phone_allowance: s.phoneAllowance,
      commission_rate: s.commissionRate,
      min_wage: s.minWage,
      fee_rates: s.feeRates,
    })
    .eq('id', 1);
  if (error) throw error;
}

// ── attendance ──
function rowToAttendance(row: any): Attendance {
  return {
    id: row.id,
    staffId: row.staff_id,
    date: row.work_date,
    in: row.clock_in,
    out: row.clock_out,
    shiftType: row.shift_type,
    phoneDuty: row.phone_duty,
    breaks: row.breaks || [],
    leaves: row.leaves || [],
    empType: row.emp_type,
    hourlyWage: row.hourly_wage,
    monthlyWage: row.monthly_wage,
    dailyWage: row.daily_wage,
    commute: row.commute,
    salesGross: row.sales_gross,
    sales: row.sales,
    uncollected: row.uncollected,
    cardFee: row.card_fee,
    payments: row.payments || {},
  };
}

export async function fetchMonth(month: string): Promise<Attendance[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .gte('work_date', `${month}-01`)
    .lte('work_date', `${month}-31`)
    .order('work_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToAttendance);
}

export async function fetchToday(dateKey: string): Promise<Attendance[]> {
  const { data, error } = await supabase.from('attendance').select('*').eq('work_date', dateKey);
  if (error) throw error;
  return (data || []).map(rowToAttendance);
}

export async function fetchOne(staffId: string, dateKey: string): Promise<Attendance | null> {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .eq('staff_id', staffId)
    .eq('work_date', dateKey)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToAttendance(data) : null;
}

/** rec全体をupsert（staffId+dateの一意制約で更新/新規を自動判定） */
export async function upsertAttendance(rec: Partial<Attendance> & { staffId: string; date: string }): Promise<Attendance> {
  const dbRow: Record<string, unknown> = {
    staff_id: rec.staffId,
    work_date: rec.date,
  };
  if (rec.in !== undefined) dbRow.clock_in = rec.in;
  if (rec.out !== undefined) dbRow.clock_out = rec.out;
  if (rec.shiftType !== undefined) dbRow.shift_type = rec.shiftType;
  if (rec.phoneDuty !== undefined) dbRow.phone_duty = rec.phoneDuty;
  if (rec.breaks !== undefined) dbRow.breaks = rec.breaks;
  if (rec.leaves !== undefined) dbRow.leaves = rec.leaves;
  if (rec.empType !== undefined) dbRow.emp_type = rec.empType;
  if (rec.hourlyWage !== undefined) dbRow.hourly_wage = rec.hourlyWage;
  if (rec.monthlyWage !== undefined) dbRow.monthly_wage = rec.monthlyWage;
  if (rec.dailyWage !== undefined) dbRow.daily_wage = rec.dailyWage;
  if (rec.commute !== undefined) dbRow.commute = rec.commute;
  if (rec.salesGross !== undefined) dbRow.sales_gross = rec.salesGross;
  if (rec.sales !== undefined) dbRow.sales = rec.sales;
  if (rec.uncollected !== undefined) dbRow.uncollected = rec.uncollected;
  if (rec.cardFee !== undefined) dbRow.card_fee = rec.cardFee;
  if (rec.payments !== undefined) dbRow.payments = rec.payments;

  const { data, error } = await supabase
    .from('attendance')
    .upsert(dbRow, { onConflict: 'staff_id,work_date' })
    .select()
    .single();
  if (error) throw error;
  return rowToAttendance(data);
}

export async function deleteAllAttendance(): Promise<void> {
  const { error } = await supabase.from('attendance').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  if (error) throw error;
}

// ── shift plan（月次シフト作成） ──
export type ShiftCode = '公' | '①' | '③' | 'シャトル便' | 'S' | '貸切';

export type Shift = {
  staffId: string;
  workDate: string; // 'YYYY-MM-DD'
  code: ShiftCode;
};

function rowToShift(row: any): Shift {
  return {
    staffId: row.staff_id,
    workDate: row.work_date,
    code: row.code,
  };
}

export async function fetchShiftMonth(month: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .gte('work_date', `${month}-01`)
    .lte('work_date', `${month}-31`);
  if (error) throw error;
  return (data || []).map(rowToShift);
}

export async function upsertShift(rec: Shift): Promise<void> {
  const { error } = await supabase
    .from('shifts')
    .upsert(
      { staff_id: rec.staffId, work_date: rec.workDate, code: rec.code },
      { onConflict: 'staff_id,work_date' }
    );
  if (error) throw error;
}

export async function deleteShift(staffId: string, workDate: string): Promise<void> {
  const { error } = await supabase
    .from('shifts')
    .delete()
    .eq('staff_id', staffId)
    .eq('work_date', workDate);
  if (error) throw error;
}

export async function fetchShiftNote(month: string): Promise<string> {
  const { data, error } = await supabase
    .from('shift_notes')
    .select('note')
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;
  return data?.note || '';
}

export async function upsertShiftNote(month: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('shift_notes')
    .upsert({ month, note }, { onConflict: 'month' });
  if (error) throw error;
}
