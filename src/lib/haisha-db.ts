/**
 * 配車管理 /haisha のデータ層。
 *
 * Supabaseクライアント・認証・スタッフマスタは勤怠 /kintai のものをそのまま使う
 * （担当者は「勤怠に入っている人」から選ぶ、という運用要件のため）。
 */
import { supabase } from './kintai-db';
import type { NormalizedRow } from './haisha-csv';
import { normalizePhoneKey } from './haisha-csv';

// 認証まわりとスタッフマスタは勤怠のものを再利用する
export { supabase, initAuth, isAdmin, isSuperAdmin, signInAdmin, signOutToKiosk, fetchStaff } from './kintai-db';
export type { Staff } from './kintai-db';
export type { NormalizedRow } from './haisha-csv';

export type Reservation = {
  id: string;
  // DS由来
  reservedAt: string;      // ISO
  reservedDate: string;    // 'YYYY-MM-DD'（JST。DBトリガーが設定）
  alarmMinutes: number | null;
  officeName: string | null;
  customerName: string;
  customerKana: string | null;
  phone: string | null;
  reservationMemo: string | null;
  operatorMemo: string | null;
  pickupName: string | null;
  pickupMemo: string | null;
  pickupAddress: string | null;
  dropoffName: string | null;
  dropoffAddress: string | null;
  registeredAt: string | null;
  registeredBy: string | null;
  // アプリ側
  staffId: string | null;
  checked: boolean;
  appMemo: string | null;
  status: ReservationStatus;
  source: 'csv' | 'manual';
  sortOrder: number | null;
  /** この行がDBに入った時刻。registeredAt が無い手入力の予約で「新着」判定に使う */
  createdAt: string | null;
};

/**
 * 予約の状態。人が手で設定する。
 * - normal    … 通常
 * - changed   … 変更あり。DS側で時間等が変わり、別行として取り込まれた古い方に付ける
 * - cancelled … キャンセル。DS側で取り消された予約に付ける
 *
 * 取り込みで自動判定はしない（誤ったCSVを1回貼っただけで大量に消える/書き換わるのを避けるため）。
 */
export type ReservationStatus = 'normal' | 'changed' | 'cancelled';

const TABLE = 'dispatch_reservations';

// ── ログイン状態 ──

/** 有効なセッションがあるか。未ログインだと参照は「0件」で返り、書き込みだけがRLSに弾かれる */
export async function hasSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  return !!data.session;
}

/**
 * ログイン切れ／RLS拒否によるエラーかどうか。
 * 通信エラーと区別して案内を出し分けるために使う
 * （「電波状況を確認してください」と出しても、ログインが切れていては永久に直らないため）。
 */
export function isAuthError(e: any): boolean {
  const code = e?.code ?? '';
  const status = Number(e?.status ?? 0);
  return code === '42501' || code === 'PGRST301' || code === 'PGRST302' || status === 401 || status === 403;
}

// ── 日付ユーティリティ（JST固定） ──

/** ISO文字列 → JSTの 'YYYY-MM-DD' */
export function jstDateKey(iso: string): string {
  const t = new Date(iso).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** ISO文字列 → JSTの 'HH:MM' */
export function jstTimeLabel(iso: string): string {
  const t = new Date(iso).getTime();
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

/** 今日のJST日付 'YYYY-MM-DD' */
export function todayJst(): string {
  return jstDateKey(new Date().toISOString());
}

// ── 行の変換 ──

function rowToReservation(row: any): Reservation {
  return {
    id: row.id,
    reservedAt: row.reserved_at,
    reservedDate: row.reserved_date,
    alarmMinutes: row.alarm_minutes,
    officeName: row.office_name,
    customerName: row.customer_name,
    customerKana: row.customer_kana,
    phone: row.phone,
    reservationMemo: row.reservation_memo,
    operatorMemo: row.operator_memo,
    pickupName: row.pickup_name,
    pickupMemo: row.pickup_memo,
    pickupAddress: row.pickup_address,
    dropoffName: row.dropoff_name,
    dropoffAddress: row.dropoff_address,
    registeredAt: row.registered_at,
    registeredBy: row.registered_by,
    staffId: row.staff_id,
    checked: row.checked,
    appMemo: row.app_memo,
    status: row.status ?? 'normal',
    source: row.source,
    sortOrder: row.sort_order,
    createdAt: row.created_at ?? null,
  };
}

/** DS由来のカラムだけを組み立てる。アプリ側カラム（staff_id等）は絶対に含めない */
function dsFields(r: NormalizedRow): Record<string, unknown> {
  return {
    reserved_at: r.reservedAt,
    alarm_minutes: r.alarmMinutes,
    office_name: r.officeName,
    customer_name: r.customerName,
    customer_kana: r.customerKana,
    phone: r.phone,
    reservation_memo: r.reservationMemo,
    operator_memo: r.operatorMemo,
    pickup_name: r.pickupName,
    pickup_memo: r.pickupMemo,
    pickup_address: r.pickupAddress,
    dropoff_name: r.dropoffName,
    dropoff_address: r.dropoffAddress,
    registered_at: r.registeredAt,
    registered_by: r.registeredBy,
  };
}

// ── 取得 ──

export async function fetchReservationsByDate(dateKey: string): Promise<Reservation[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('reserved_date', dateKey)
    .order('reserved_at', { ascending: true })
    .order('sort_order', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return (data || []).map(rowToReservation);
}

export async function fetchReservationsRange(fromDate: string, toDate: string): Promise<Reservation[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .gte('reserved_date', fromDate)
    .lte('reserved_date', toDate)
    .order('reserved_at', { ascending: true });
  if (error) throw error;
  return (data || []).map(rowToReservation);
}

// ── 追加・更新・削除 ──

export type ReservationInput = {
  reservedAt: string;
  customerName: string;
  customerKana?: string | null;
  phone?: string | null;
  alarmMinutes?: number | null;
  pickupName?: string | null;
  pickupAddress?: string | null;
  pickupMemo?: string | null;
  dropoffName?: string | null;
  dropoffAddress?: string | null;
  operatorMemo?: string | null;
  reservationMemo?: string | null;
  staffId?: string | null;
  appMemo?: string | null;
  status?: ReservationStatus;
};

/** アプリ上での手入力。source は 'manual'（CSV照合の対象外にする） */
export async function insertReservation(input: ReservationInput): Promise<Reservation> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      reserved_at: input.reservedAt,
      reserved_date: jstDateKey(input.reservedAt), // NOT NULL制約のため。値はトリガーが上書きする
      customer_name: input.customerName,
      customer_kana: input.customerKana ?? null,
      phone: input.phone ?? null,
      alarm_minutes: input.alarmMinutes ?? null,
      pickup_name: input.pickupName ?? null,
      pickup_address: input.pickupAddress ?? null,
      pickup_memo: input.pickupMemo ?? null,
      dropoff_name: input.dropoffName ?? null,
      dropoff_address: input.dropoffAddress ?? null,
      operator_memo: input.operatorMemo ?? null,
      reservation_memo: input.reservationMemo ?? null,
      staff_id: input.staffId ?? null,
      app_memo: input.appMemo ?? null,
      status: input.status ?? 'normal',
      source: 'manual',
    })
    .select()
    .single();
  if (error) throw error;
  return rowToReservation(data);
}

export async function updateReservation(id: string, patch: Partial<ReservationInput>): Promise<void> {
  const db: Record<string, unknown> = {};
  if (patch.reservedAt !== undefined) db.reserved_at = patch.reservedAt;
  if (patch.customerName !== undefined) db.customer_name = patch.customerName;
  if (patch.customerKana !== undefined) db.customer_kana = patch.customerKana;
  if (patch.phone !== undefined) db.phone = patch.phone;
  if (patch.alarmMinutes !== undefined) db.alarm_minutes = patch.alarmMinutes;
  if (patch.pickupName !== undefined) db.pickup_name = patch.pickupName;
  if (patch.pickupAddress !== undefined) db.pickup_address = patch.pickupAddress;
  if (patch.pickupMemo !== undefined) db.pickup_memo = patch.pickupMemo;
  if (patch.dropoffName !== undefined) db.dropoff_name = patch.dropoffName;
  if (patch.dropoffAddress !== undefined) db.dropoff_address = patch.dropoffAddress;
  if (patch.operatorMemo !== undefined) db.operator_memo = patch.operatorMemo;
  if (patch.reservationMemo !== undefined) db.reservation_memo = patch.reservationMemo;
  if (patch.staffId !== undefined) db.staff_id = patch.staffId;
  if (patch.appMemo !== undefined) db.app_memo = patch.appMemo;
  if (patch.status !== undefined) db.status = patch.status;
  if (Object.keys(db).length === 0) return;

  const { error } = await supabase.from(TABLE).update(db).eq('id', id);
  if (error) throw error;
}

export async function deleteReservation(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}

/** 担当者の割り当て。配車ボードから即保存で呼ばれる */
export async function assignStaff(id: string, staffId: string | null): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ staff_id: staffId }).eq('id', id);
  if (error) throw error;
}

export async function setChecked(id: string, checked: boolean): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ checked }).eq('id', id);
  if (error) throw error;
}

/** 状態（通常／変更あり／キャンセル）の変更。配車ボードから即保存で呼ばれる */
export async function setStatus(id: string, status: ReservationStatus): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ status }).eq('id', id);
  if (error) throw error;
}

// ── その日の勤務（/shift の内容を読むだけ。編集は /shift 側で行う） ──

export type DutyEntry = { staffId: string; code: string; phoneDuty: boolean };

/**
 * 指定日のシフトを取得する。
 * 配車ボードで「今日は誰がどの区分で出ているか」を見るために使う。
 * 書き込みはしない（シフトの正は /shift ページ）。
 */
export async function fetchShiftsByDate(dateKey: string): Promise<DutyEntry[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('staff_id, code, phone_duty')
    .eq('work_date', dateKey);
  if (error) throw error;
  return (data || []).map((r: any) => ({ staffId: r.staff_id, code: r.code, phoneDuty: r.phone_duty }));
}

// ── 変更履歴（DBトリガーが自動記録。クライアントからは読み取りと復元のみ） ──

export type HistoryAction = 'insert' | 'update' | 'delete';

export type HistoryEntry = {
  id: string;
  reservationId: string;
  action: HistoryAction;
  oldRow: Record<string, any> | null;
  newRow: Record<string, any> | null;
  changedBy: string | null;
  changedAt: string;
};

function rowToHistory(row: any): HistoryEntry {
  return {
    id: row.id,
    reservationId: row.reservation_id,
    action: row.action,
    oldRow: row.old_row,
    newRow: row.new_row,
    changedBy: row.changed_by,
    changedAt: row.changed_at,
  };
}

export async function fetchDispatchHistory(limit = 100): Promise<HistoryEntry[]> {
  const { data, error } = await supabase
    .from('dispatch_history')
    .select('*')
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToHistory);
}

/** 復元の対象にする列。id・作成日時・reserved_date（トリガーが再計算）は含めない */
const RESTORABLE_COLUMNS = [
  'reserved_at', 'alarm_minutes', 'office_name', 'customer_name', 'customer_kana', 'phone',
  'reservation_memo', 'operator_memo', 'pickup_name', 'pickup_memo', 'pickup_address',
  'dropoff_name', 'dropoff_address', 'registered_at', 'registered_by',
  'staff_id', 'checked', 'app_memo', 'status', 'source', 'sort_order',
];

function pickRestorable(row: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const c of RESTORABLE_COLUMNS) if (c in row) out[c] = row[c];
  return out;
}

/**
 * 履歴1件を取り消して、変更前の状態に戻す。
 * - update / insert … その予約を変更前の値に戻す（insert の取り消しは削除）
 * - delete          … 消された予約を同じidで復元する
 *
 * 戻す操作自体も履歴に残る（トリガーが記録するため）。
 */
export async function revertHistoryEntry(entry: HistoryEntry): Promise<void> {
  if (entry.action === 'delete') {
    if (!entry.oldRow) throw new Error('復元するデータがありません。');
    const payload = { id: entry.reservationId, ...pickRestorable(entry.oldRow) };
    // reserved_date は NOT NULL。値はトリガーが上書きする
    (payload as any).reserved_date = jstDateKey(entry.oldRow.reserved_at);
    const { error } = await supabase.from(TABLE).insert(payload);
    if (error) throw error;
    return;
  }

  if (entry.action === 'insert') {
    const { error } = await supabase.from(TABLE).delete().eq('id', entry.reservationId);
    if (error) throw error;
    return;
  }

  if (!entry.oldRow) throw new Error('変更前のデータがありません。');
  const { error } = await supabase.from(TABLE).update(pickRestorable(entry.oldRow)).eq('id', entry.reservationId);
  if (error) throw error;
}

// ── 引き継ぎ ──

/**
 * 事務所終了後などに配車担当者が交代する際の記録。
 * 「新着」判定の基準時刻になる（この時刻以降に登録された予約が新着）。
 * 記録が1件も無い場合は、何も新着にしない（haisha.astro 側）。
 * 固定の交代時刻は持たないので、運用が18時→19時に変わってもコード変更は不要。
 */
export type Handover = {
  id: string;
  handedOverAt: string;
  handedOverBy: string | null;
  note: string | null;
};

function rowToHandover(row: any): Handover {
  return {
    id: row.id,
    handedOverAt: row.handed_over_at,
    handedOverBy: row.handed_over_by,
    note: row.note,
  };
}

export async function fetchLatestHandover(): Promise<Handover | null> {
  const { data, error } = await supabase
    .from('dispatch_handovers')
    .select('*')
    .order('handed_over_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToHandover(data) : null;
}

/**
 * 引き継ぎを記録する。記録時刻が「新着」の基準になる。
 * atIso を渡すとその時刻で記録する（現状の呼び出しでは未使用だが、
 * 基準時刻を明示したい場合のために残してある）。
 */
export async function recordHandover(
  by: string | null,
  note: string | null,
  atIso?: string
): Promise<Handover> {
  const payload: Record<string, unknown> = { handed_over_by: by, note };
  if (atIso) payload.handed_over_at = atIso;
  const { data, error } = await supabase
    .from('dispatch_handovers')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return rowToHandover(data);
}

/**
 * 申し送りだけを書き換える。handed_over_at は触らないので、
 * 「新着」の基準は変わらない（追記のたびに新着が消えるのを避けるため）。
 */
export async function updateHandoverNote(id: string, note: string | null): Promise<void> {
  const { error } = await supabase.from('dispatch_handovers').update({ note }).eq('id', id);
  if (error) throw error;
}

/** 誤操作の取り消し用。最新の1件を消すと、その前の引き継ぎが基準に戻る */
export async function deleteHandover(id: string): Promise<void> {
  const { error } = await supabase.from('dispatch_handovers').delete().eq('id', id);
  if (error) throw error;
}

// ── 担当者候補の設定（管理者のみ） ──

/**
 * 配車の担当者候補に出すかを切り替える。
 * 氏名ではなく id で更新する（異体字・表記ゆれで別人を触るのを防ぐため）。
 * staff テーブルの更新はRLSで管理者に限定されている。
 */
export async function setStaffAssignable(staffId: string, assignable: boolean): Promise<void> {
  const { error } = await supabase.from('staff').update({ haisha_assignable: assignable }).eq('id', staffId);
  if (error) throw error;
}

// ── 日次の勤務割り当て（前日に確定する区分。/shift に該当コードが無いもの） ──

/**
 * スクール原町・交流・貸切は月次シフト（/shift）では決まらず、日ごとに確定するため /haisha 側で持つ。
 * 貸切は当初 /shift の 貸切 コードを読むだけだったが、予約ごとに都度決まる性質のため
 * こちらの日次割り当てに変更した（/shift 側の 貸切 コードは月次シフト表示として引き続き使える）。
 */
export type DutyCategory = 'school_haramachi' | 'exchange' | 'charter';

export type DailyDuty = { category: DutyCategory; staffId: string };

export async function fetchDailyDuties(dateKey: string): Promise<DailyDuty[]> {
  const { data, error } = await supabase
    .from('dispatch_duties')
    .select('category, staff_id')
    .eq('work_date', dateKey);
  if (error) throw error;
  return (data || []).map((r: any) => ({ category: r.category, staffId: r.staff_id }));
}

export async function addDailyDuty(dateKey: string, category: DutyCategory, staffId: string): Promise<void> {
  const { error } = await supabase
    .from('dispatch_duties')
    .upsert(
      { work_date: dateKey, category, staff_id: staffId },
      { onConflict: 'work_date,category,staff_id', ignoreDuplicates: true }
    );
  if (error) throw error;
}

export async function removeDailyDuty(dateKey: string, category: DutyCategory, staffId: string): Promise<void> {
  const { error } = await supabase
    .from('dispatch_duties')
    .delete()
    .eq('work_date', dateKey)
    .eq('category', category)
    .eq('staff_id', staffId);
  if (error) throw error;
}

// ── CSV取り込み ──

export type ImportPlan = {
  inserts: NormalizedRow[];
  updates: { id: string; row: NormalizedRow; hasStaff: boolean }[];
  /** ファイル内で重複していて後勝ちで捨てた件数 */
  duplicatesInFile: number;
  dateFrom: string;
  dateTo: string;
};

export type ImportResult = { inserted: number; updated: number };

/** 既存行と取り込み行の照合キー。予約時刻（ミリ秒）＋電話番号の正規化値 */
function matchKey(reservedAt: string, phone: string | null): string {
  return `${new Date(reservedAt).getTime()}|${normalizePhoneKey(phone)}`;
}

/**
 * 取り込み前の差分計算。実際には書き込まない。
 * UIで「新規◯件・更新◯件」を見せてから確定させるために分けてある。
 */
export async function buildImportPlan(rows: NormalizedRow[]): Promise<ImportPlan> {
  if (rows.length === 0) {
    const today = todayJst();
    return { inserts: [], updates: [], duplicatesInFile: 0, dateFrom: today, dateTo: today };
  }

  // ファイル内の重複は後勝ちで1件に寄せる
  const byKey = new Map<string, NormalizedRow>();
  let duplicatesInFile = 0;
  for (const r of rows) {
    const k = matchKey(r.reservedAt, r.phone);
    if (byKey.has(k)) duplicatesInFile++;
    byKey.set(k, r);
  }
  const unique = [...byKey.values()];

  const dates = unique.map((r) => jstDateKey(r.reservedAt)).sort();
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];

  const existing = await fetchReservationsRange(dateFrom, dateTo);
  const existingByKey = new Map<string, Reservation>();
  for (const e of existing) existingByKey.set(matchKey(e.reservedAt, e.phone), e);

  const inserts: NormalizedRow[] = [];
  const updates: ImportPlan['updates'] = [];
  for (const [k, row] of byKey) {
    const hit = existingByKey.get(k);
    if (hit) updates.push({ id: hit.id, row, hasStaff: hit.staffId !== null });
    else inserts.push(row);
  }

  return { inserts, updates, duplicatesInFile, dateFrom, dateTo };
}

/**
 * 差分を実際に書き込む。
 *
 * 更新は DS由来のカラムだけを送る。staff_id / checked / app_memo / sort_order は
 * 触らないため、担当者を割り当てた後にCSVを入れ直しても割り当ては消えない。
 */
export async function applyImportPlan(plan: ImportPlan): Promise<ImportResult> {
  if (plan.inserts.length > 0) {
    const payload = plan.inserts.map((r) => ({
      ...dsFields(r),
      reserved_date: jstDateKey(r.reservedAt), // NOT NULL制約のため。値はトリガーが上書きする
      source: 'csv',
    }));
    // 一度に送る件数を抑える（1日分は20〜30件程度だが、まとめ取り込みに備える）
    for (let i = 0; i < payload.length; i += 100) {
      const { error } = await supabase.from(TABLE).insert(payload.slice(i, i + 100));
      if (error) throw error;
    }
  }

  // 更新は1行ずつ。DS由来カラムのみを送ることを型ではなく発行内容で保証する
  const CONCURRENCY = 8;
  for (let i = 0; i < plan.updates.length; i += CONCURRENCY) {
    const chunk = plan.updates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((u) => supabase.from(TABLE).update(dsFields(u.row)).eq('id', u.id))
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw failed.error;
  }

  return { inserted: plan.inserts.length, updated: plan.updates.length };
}

/** パーサ非依存の取り込み入口。将来DSコネクトのAPI連携に差し替える際はここを呼ぶ */
export async function importReservations(rows: NormalizedRow[]): Promise<ImportResult> {
  const plan = await buildImportPlan(rows);
  return applyImportPlan(plan);
}
