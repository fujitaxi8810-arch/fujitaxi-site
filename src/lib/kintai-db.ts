import { createClient, isAuthRetryableFetchError } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

/** 'YYYY-MM' の翌月の 'YYYY-MM' を返す。月次データ取得の範囲指定（排他的上限）に使う。 */
function nextMonthStr(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 1); // m は1-indexedなのでこれで翌月1日になる
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export type EmpType = 'fulltime' | 'fulltime-base' | 'fulltime-hourly' | 'part' | 'monthly';

export type BreakMode = 'punch' | 'fixed' | 'manual';

export type Staff = {
  id: string;
  name: string;
  displayOrder: number;
  type: EmpType;
  hourlyWage: number | null;
  monthlyWage: number | null;
  dailyWage: number | null;
  commuteAllowance: number;
  commuteType: 'monthly' | 'daily';
  breakMode: BreakMode;
  breakFixedMinutes: number | null;
  managerAllowance: number;
  housingAllowance: number;
  phoneDutyDisabled: boolean;
  lateShiftDisabled: boolean;
  shiftShuttle: boolean;
  shiftSpecial: boolean;
  shiftSchool: boolean;
  shiftSchoolHaramachi: boolean;
  /** SHS（乗合＋スクール）を使えるか。乗合を担当しつつスクール送迎も兼ねる人向け */
  shiftShuttleSchool: boolean;
  /**
   * ①（普通番）の勤務時間がこの人だけ違う場合の表記（例 '8:00-17:00'）。
   * null なら既定の 7:00-16:00。表示用のラベルだけに使い、給与計算には影響しない
   */
  shiftNormalHours: string | null;
  /**
   * この人が選べるシフトコードを明示的に絞る場合の一覧。
   * null なら上の各フラグから組み立てた既定の並び
   */
  shiftCodes: string[] | null;
  shiftGroup: 'office' | 'maintenance' | 'jumbo' | null;
  shiftDisplayOrder: number | null;
  /** 配車(/haisha)の担当者候補に出すか。列が無い環境では true 扱い */
  haishaAssignable: boolean;
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
  commuteType: 'monthly' | 'daily' | null;
  breakMode: BreakMode | null;
  breakFixedMinutes: number | null;
  manualBreakMinutes: number | null;
  managerAllowance: number | null;
  housingAllowance: number | null;
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
 * 従業員は何も入力せずに使えるようにする（Supabaseの匿名ログイン機能）。
 * 「従業員はパスワード・メールアドレス入力が不要、管理者だけがログインすればいい」という
 * ユーザー要望への対応。匿名ユーザーもRLS上は authenticated 扱いになるため、
 * 既存のポリシー（`to authenticated`）はそのまま変更なしで動く。
 *
 * Supabaseダッシュボードで「Anonymous Sign-Ins」を有効化する必要がある
 * （Authentication → Sign In / Providers）。無効なままだとエラーになるので、
 * その場合だけ旧来の共有ログイン（メール/パスワードを一度だけ入力）にフォールバックする
 * ―― 設定前でも従業員が完全に使えなくなることは無いようにするため。
 */
async function signInAnonymousOrFallback(): Promise<{ ok: boolean; error?: string }> {
  const { error: anonError } = await supabase.auth.signInAnonymously();
  if (!anonError) return { ok: true };

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
    // 通信エラーなど一時的な失敗では保存済みのログイン情報を消さない（次回そのまま再利用できるように）。
    // メールアドレス／パスワードが実際に無効な場合のみ消して、次回また入力してもらう。
    if (!isAuthRetryableFetchError(error)) {
      localStorage.removeItem(KIOSK_CRED_KEY);
      return { ok: false, error: `ログインに失敗しました：${error.message}` };
    }
    return { ok: false, error: '通信エラーのため接続できませんでした。電波状況を確認してもう一度お試しください。' };
  }
  localStorage.setItem(KIOSK_CRED_KEY, JSON.stringify(cred));
  return { ok: true };
}

/**
 * 端末にセッションが無ければ、従業員として（無ければ管理者以外の誰でも）使える状態にする。
 * 既に管理者としてログイン済みのセッションがあれば、それをそのまま使う
 * （＝管理者は一度ログインすればSupabaseのセッション永続化で覚えたままになる）。
 */
export async function ensureKioskSession(): Promise<{ ok: boolean; error?: string }> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session) return { ok: true };
  return signInAnonymousOrFallback();
}

let cachedIsAdmin = false;
let cachedAdminEmail: string | null = null;

// 「全打刻データを削除」など特に破壊的な操作は、管理者の中でもこのメールアドレスのみに限定する
const SUPER_ADMIN_EMAILS = ['admin@fujitaxi.local'];

export function isAdmin(): boolean {
  return cachedIsAdmin;
}

export function isSuperAdmin(): boolean {
  return cachedIsAdmin && !!cachedAdminEmail && SUPER_ADMIN_EMAILS.includes(cachedAdminEmail);
}

async function refreshAdminFlag(): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const role = data.session?.user?.app_metadata?.role;
  cachedIsAdmin = role === 'admin';
  cachedAdminEmail = cachedIsAdmin ? (data.session?.user?.email ?? null) : null;
}

export async function initAuth(): Promise<{ ok: boolean; error?: string }> {
  const result = await ensureKioskSession();
  if (result.ok) await refreshAdminFlag();
  return result;
}

/**
 * 端末側ではなく、Supabase側の一時的な障害と分かっている失敗かどうか。
 * 2026-08-14〜のSupabase障害「401 errors due to JWT rejections」で、
 * データの読み込みが軒並み PGRST303 (JWT issued at future) で失敗する事例を確認した
 * （端末の時計・電波状況は正常で、プロジェクトの再起動で解消した）。
 * このエラーを「電波状況を確認してください」と案内すると、端末側の問題だと
 * 誤解して時間を浪費してしまうため、分かる範囲では専用の案内を出す
 */
export function isBackendOutage(e: any): boolean {
  const code = e?.code ?? '';
  const status = Number(e?.status ?? 0);
  return code === 'PGRST303' || status === 503 || status === 502 || status === 504;
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
  cachedAdminEmail = data.session.user.email ?? null;
  return { ok: true };
}

export async function signOutToKiosk(): Promise<void> {
  await supabase.auth.signOut();
  cachedIsAdmin = false;
  cachedAdminEmail = null;
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
    commuteType: row.commute_type || 'monthly',
    breakMode: row.break_mode || 'punch',
    breakFixedMinutes: row.break_fixed_minutes,
    managerAllowance: row.manager_allowance ?? 0,
    housingAllowance: row.housing_allowance ?? 0,
    phoneDutyDisabled: row.phone_duty_disabled,
    lateShiftDisabled: row.late_shift_disabled,
    shiftShuttle: row.shift_shuttle,
    shiftSpecial: row.shift_special,
    shiftSchool: row.shift_school ?? false,
    shiftSchoolHaramachi: row.shift_school_haramachi ?? false,
    shiftShuttleSchool: row.shift_shuttle_school ?? false,
    shiftNormalHours: row.shift_normal_hours ?? null,
    // 列が無い環境・空配列はどちらも「指定なし」として扱う
    shiftCodes: Array.isArray(row.shift_codes) && row.shift_codes.length ? row.shift_codes : null,
    shiftGroup: row.shift_group,
    shiftDisplayOrder: row.shift_display_order,
    haishaAssignable: row.haisha_assignable ?? true,
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
  commuteType?: 'monthly' | 'daily';
  breakMode?: BreakMode;
  breakFixedMinutes?: number | null;
  managerAllowance?: number;
  housingAllowance?: number;
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
      commute_type: input.commuteType ?? 'monthly',
      break_mode: input.breakMode ?? 'punch',
      break_fixed_minutes: input.breakFixedMinutes ?? null,
      manager_allowance: input.managerAllowance ?? 0,
      housing_allowance: input.housingAllowance ?? 0,
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
  commuteType: 'monthly' | 'daily';
  breakMode: BreakMode;
  breakFixedMinutes: number | null;
  managerAllowance: number;
  housingAllowance: number;
}>): Promise<void> {
  const dbPatch: Record<string, unknown> = {};
  if (patch.type !== undefined) dbPatch.emp_type = patch.type;
  if (patch.hourlyWage !== undefined) dbPatch.hourly_wage = patch.hourlyWage;
  if (patch.monthlyWage !== undefined) dbPatch.monthly_wage = patch.monthlyWage;
  if (patch.dailyWage !== undefined) dbPatch.daily_wage = patch.dailyWage;
  if (patch.commuteAllowance !== undefined) dbPatch.commute_allowance = patch.commuteAllowance;
  if (patch.commuteType !== undefined) dbPatch.commute_type = patch.commuteType;
  if (patch.breakMode !== undefined) dbPatch.break_mode = patch.breakMode;
  if (patch.breakFixedMinutes !== undefined) dbPatch.break_fixed_minutes = patch.breakFixedMinutes;
  if (patch.managerAllowance !== undefined) dbPatch.manager_allowance = patch.managerAllowance;
  if (patch.housingAllowance !== undefined) dbPatch.housing_allowance = patch.housingAllowance;
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
    commuteType: row.commute_type,
    breakMode: row.break_mode,
    breakFixedMinutes: row.break_fixed_minutes,
    manualBreakMinutes: row.manual_break_minutes,
    managerAllowance: row.manager_allowance,
    housingAllowance: row.housing_allowance,
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
    .lt('work_date', `${nextMonthStr(month)}-01`)
    .order('work_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToAttendance);
}

export async function fetchToday(dateKey: string): Promise<Attendance[]> {
  const { data, error } = await supabase.from('attendance').select('*').eq('work_date', dateKey);
  if (error) throw error;
  return (data || []).map(rowToAttendance);
}

/**
 * 「本日の状況」用。今日の日付のレコードに加えて、前日付けのまま退勤していない
 * レコード（日をまたぐ遅番など）も一緒に取得する。
 */
export async function fetchTodayOrOpen(dateKey: string, prevDateKey: string): Promise<Attendance[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .or(`work_date.eq.${dateKey},and(work_date.eq.${prevDateKey},clock_out.is.null)`);
  if (error) throw error;
  return (data || []).map(rowToAttendance);
}

/**
 * 打刻忘れ検知用。退勤していない（clock_outがnull）レコードを日付を問わず全件取得する。
 */
export async function fetchOpenAttendance(): Promise<Attendance[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('*')
    .is('clock_out', null)
    .order('work_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToAttendance);
}

/** バックアップ用。期間を問わず全打刻データを取得する。 */
export async function fetchAllAttendance(): Promise<Attendance[]> {
  const { data, error } = await supabase.from('attendance').select('*').order('work_date', { ascending: true });
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
  if (rec.commuteType !== undefined) dbRow.commute_type = rec.commuteType;
  if (rec.breakMode !== undefined) dbRow.break_mode = rec.breakMode;
  if (rec.breakFixedMinutes !== undefined) dbRow.break_fixed_minutes = rec.breakFixedMinutes;
  if (rec.manualBreakMinutes !== undefined) dbRow.manual_break_minutes = rec.manualBreakMinutes;
  if (rec.managerAllowance !== undefined) dbRow.manager_allowance = rec.managerAllowance;
  if (rec.housingAllowance !== undefined) dbRow.housing_allowance = rec.housingAllowance;
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

/** 直後の打刻取り消し用：新規作成したレコード1件だけを削除する */
export async function deleteAttendance(id: string): Promise<void> {
  const { error } = await supabase.from('attendance').delete().eq('id', id);
  if (error) throw error;
}

// ── 月次出力状況（CSV・給与計算Excelの出力し忘れ防止。全管理者・全端末で共有） ──
export type ExportKind = 'csv' | 'excel';
export type ExportLogEntry = { kind: ExportKind; exportedAt: string };

export async function fetchExportLog(month: string): Promise<ExportLogEntry[]> {
  const { data, error } = await supabase.from('export_log').select('kind, exported_at').eq('month', month);
  if (error) throw error;
  return (data || []).map((r: any) => ({ kind: r.kind, exportedAt: r.exported_at }));
}

export async function recordExport(month: string, kind: ExportKind): Promise<void> {
  const { error } = await supabase
    .from('export_log')
    .upsert({ month, kind, exported_at: new Date().toISOString() }, { onConflict: 'month,kind' });
  if (error) throw error;
}

// ── shift plan（月次シフト作成） ──
export type ShiftCode = '公' | '①' | '①S' | '①H' | '③' | 'SH' | 'SHS' | 'S' | '貸切' | '有給';

export type Shift = {
  staffId: string;
  workDate: string; // 'YYYY-MM-DD'
  code: ShiftCode;
  phoneDuty: boolean;
  /**
   * 交流の送迎を担当するかの印。コードとは独立（どのシフトコードの日でも立てられる）。
   * phoneDuty と同じ考え方で、シフト表のセルに小さな印（下線）を出すためのフラグ
   */
  exchangeDuty: boolean;
};

function rowToShift(row: any): Shift {
  return {
    staffId: row.staff_id,
    workDate: row.work_date,
    code: row.code,
    phoneDuty: row.phone_duty,
    exchangeDuty: row.exchange_duty ?? false,
  };
}

export async function fetchShiftMonth(month: string): Promise<Shift[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('*')
    .gte('work_date', `${month}-01`)
    .lt('work_date', `${nextMonthStr(month)}-01`);
  if (error) throw error;
  return (data || []).map(rowToShift);
}

/** バックアップ用。期間を問わず全シフトデータを取得する。 */
export async function fetchAllShifts(): Promise<Shift[]> {
  const { data, error } = await supabase.from('shifts').select('*').order('work_date', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToShift);
}

export async function upsertShift(rec: Shift): Promise<void> {
  const { error } = await supabase
    .from('shifts')
    .upsert(
      {
        staff_id: rec.staffId,
        work_date: rec.workDate,
        code: rec.code,
        phone_duty: rec.phoneDuty,
        exchange_duty: rec.exchangeDuty,
      },
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

/** バックアップ用。全月分のシフト備考を取得する。 */
export async function fetchAllShiftNotes(): Promise<{ month: string; note: string }[]> {
  const { data, error } = await supabase.from('shift_notes').select('month, note').order('month', { ascending: true });
  if (error) throw error;
  return (data || []).map((r: any) => ({ month: r.month, note: r.note }));
}

export async function upsertShiftNote(month: string, note: string): Promise<void> {
  const { error } = await supabase
    .from('shift_notes')
    .upsert({ month, note }, { onConflict: 'month' });
  if (error) throw error;
}

// ── shift history（DBトリガーが自動記録。クライアントからは読み取りのみ） ──
export type ShiftHistoryEntry = {
  id: string;
  staffId: string;
  workDate: string;
  oldCode: ShiftCode | null;
  newCode: ShiftCode | null;
  oldPhoneDuty: boolean | null;
  newPhoneDuty: boolean | null;
  changedBy: string | null;
  changedAt: string;
};

function rowToShiftHistory(row: any): ShiftHistoryEntry {
  return {
    id: row.id,
    staffId: row.staff_id,
    workDate: row.work_date,
    oldCode: row.old_code,
    newCode: row.new_code,
    oldPhoneDuty: row.old_phone_duty,
    newPhoneDuty: row.new_phone_duty,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}

export async function fetchShiftHistory(month: string): Promise<ShiftHistoryEntry[]> {
  const { data, error } = await supabase
    .from('shift_history')
    .select('*')
    .gte('work_date', `${month}-01`)
    .lt('work_date', `${nextMonthStr(month)}-01`)
    .order('changed_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data || []).map(rowToShiftHistory);
}
