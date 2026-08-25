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
export { supabase, initAuth, isAdmin, isSuperAdmin, signInAdmin, signOutToKiosk, fetchStaff, isBackendOutage } from './kintai-db';
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
  /**
   * status が 'changed' のとき、取り込みで「同じ予約の時刻違い」と判定して
   * 紐付けた新しい予約のid。手動でstatusを変えた場合や、この機能の追加前に
   * 変更ありになった予約では null のまま
   */
  supersededBy: string | null;
  /**
   * supersededBy が指す予約のDS由来カラム（生の列名のまま）。一覧・ボードで
   * 「→ 何時に変更」に加え、迎車場所・メモ等の違いも見せるために埋め込み取得する。
   * 列名はDBそのまま（reserved_at 等）。既存の `diffFields`（変更履歴で使用）と
   * そのまま比較できるようにするため、あえてキャメルケースに変換しない
   */
  supersededByRaw: Record<string, any> | null;
  /**
   * 逆方向：自分を「変更後の予約」として指している、変更前の予約の日時。
   * 「新しい予約を見ても、元は別の予約だと分からない」への対応。
   * 複数から指されることは無い想定（1つの予約は高々1回しか「変更あり」の
   * 行き先にならない）ので先頭の1件だけ見る
   */
  supersededFromReservedAt: string | null;
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
    supersededBy: row.superseded_by ?? null,
    // Supabaseの埋め込み取得は配列で返ることがある（1件でも）。両方の形に対応しておく
    supersededByRaw: (Array.isArray(row.superseded) ? row.superseded[0] : row.superseded) ?? null,
    supersededFromReservedAt:
      (Array.isArray(row.supersededFrom) ? row.supersededFrom[0] : row.supersededFrom)?.reserved_at ?? null,
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

/*
 * superseded_by で指している「変更後の予約」を一緒に取ってくる。
 * 一覧・ボードの表示期間の外に変更後の予約があっても表示できるよう、
 * 別読み込みではなくこの埋め込みで一度に取得する。
 *
 * 時刻だけでなく、DS由来の項目（迎車場所・メモ等）も取っておく。
 * 「時刻以外に何が変わったか」も一緒に見せたい、という要望への対応（2026-08-21）。
 * staff_id・checked・app_memo・status はアプリ側の状態で、新旧で違って当然のため含めない。
 */
/*
 * supersededFrom は逆方向（自分を「変更後の予約」として指している古い予約）。
 * 新しい方の予約を見ても「これは別の予約が変更されてできたもの」と分かるように
 * するための要望（2026-08-21）。自己参照FKの逆embedは `テーブル名!列名` で書く
 * （本番のSupabaseに対して実際にクエリを投げ、この書き方で通ることを確認済み）。
 */
const SELECT_WITH_SUPERSEDED = `*, superseded:superseded_by(
  reserved_at, alarm_minutes, office_name, customer_kana,
  reservation_memo, operator_memo, pickup_name, pickup_memo, pickup_address,
  dropoff_name, dropoff_address
), supersededFrom:dispatch_reservations!superseded_by(reserved_at)`;

export async function fetchReservationsByDate(dateKey: string): Promise<Reservation[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_WITH_SUPERSEDED)
    .eq('reserved_date', dateKey)
    .order('reserved_at', { ascending: true })
    .order('sort_order', { ascending: true, nullsFirst: true });
  if (error) throw error;
  return (data || []).map(rowToReservation);
}

export async function fetchReservationsRange(fromDate: string, toDate: string): Promise<Reservation[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_WITH_SUPERSEDED)
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

export type DutyEntry = {
  staffId: string;
  code: string;
  phoneDuty: boolean;
  /** 交流の送迎を担当する印（/shift 側でコードとは別に立てる。§5.5参照） */
  exchangeDuty: boolean;
};

/**
 * 指定日のシフトを取得する。
 * 配車ボードで「今日は誰がどの区分で出ているか」を見るために使う。
 * 書き込みはしない（シフトの正は /shift ページ）。
 */
export async function fetchShiftsByDate(dateKey: string): Promise<DutyEntry[]> {
  const { data, error } = await supabase
    .from('shifts')
    .select('staff_id, code, phone_duty, exchange_duty')
    .eq('work_date', dateKey);
  if (error) throw error;
  return (data || []).map((r: any) => ({
    staffId: r.staff_id,
    code: r.code,
    phoneDuty: r.phone_duty,
    exchangeDuty: r.exchange_duty ?? false,
  }));
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

// ── 削除された予約の確認 ──
// 「消した予約もデータとしては残しておきたい」という要望への対応。
// 削除自体は dispatch_reservations から行が無くなるが、
// dispatch_history に action='delete' として old_row のスナップショットが残っている
// （DBトリガーが自動記録。§5.47参照）ので、そこから復元して一覧表示する。

export type DeletedReservation = {
  historyId: string;
  reservationId: string;
  deletedAt: string;
  deletedBy: string | null;
  /** old_row そのまま（reserved_at, customer_name, customer_kana など） */
  row: Record<string, any>;
};

export async function fetchDeletedReservations(limit = 500): Promise<DeletedReservation[]> {
  const { data, error } = await supabase
    .from('dispatch_history')
    .select('*')
    .eq('action', 'delete')
    .order('changed_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || [])
    .filter((r: any) => r.old_row)
    .map((r: any) => ({
      historyId: r.id,
      reservationId: r.reservation_id,
      deletedAt: r.changed_at,
      deletedBy: r.changed_by,
      row: r.old_row,
    }));
}

/** 削除された予約1件を復元する。中身は revertHistoryEntry の delete 分岐と同じ */
export async function restoreDeletedReservation(d: DeletedReservation): Promise<void> {
  await revertHistoryEntry({
    id: d.historyId,
    reservationId: d.reservationId,
    action: 'delete',
    oldRow: d.row,
    newRow: null,
    changedBy: d.deletedBy,
    changedAt: d.deletedAt,
  });
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
 * スクール原町・交流・貸切・スクールは月次シフト（/shift）では決まらず、日ごとに確定するため /haisha 側で持つ。
 * 貸切・スクールは当初 /shift のコード（貸切／S）を読むだけだったが、当日追加で
 * 人が変わることがあるため、こちらの日次割り当ても併用するようにした
 * （/shift 側のコードは月次シフト表示として引き続き使える。基本の担当はそちらで見る）。
 */
export type DutyCategory = 'school_haramachi' | 'exchange' | 'charter' | 'school';

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

/**
 * CSVの対象期間にあった既存予約（CSV由来・まだ人が状態を変えていないもの）のうち、
 * 今回のCSVに見当たらなくなったもの。
 *
 * matchedInsertId が付いていれば「同じ電話番号の新規予約」が今回のCSVに
 * あったということなので、時刻変更の可能性が高い（→ changed）。
 * 付いていなければ、単に無くなった＝キャンセルの可能性が高い（→ cancelled）。
 *
 * どちらも確定ではなく「可能性」なので、取り込み前にプレビューで件数を見せ、
 * ユーザーが実行を選ぶ形にする（自動で確定させると、同じ電話番号を複数人・
 * 施設で共有しているケースなどで誤判定しうるため）。
 */
export type MissingReservation = {
  id: string;
  customerName: string;
  reservedAt: string;
  matchedInsertId: string | null; // inserts[].tempId と対応
};

export type ImportPlan = {
  inserts: (NormalizedRow & { tempId: string })[];
  updates: { id: string; row: NormalizedRow; hasStaff: boolean }[];
  missing: MissingReservation[];
  /** ファイル内で重複していて後勝ちで捨てた件数 */
  duplicatesInFile: number;
  /**
   * 既存と一致し、かつDS由来の内容が1文字も変わっていなかった件数。
   * DSのCSVは毎回すべての予約が出てくるため、これが件数の大半を占める。
   * 「更新◯件」に混ぜると本当に変わった予約が埋もれるので、書き込みもせず別に数える。
   */
  unchanged: number;
  dateFrom: string;
  dateTo: string;
};

export type ImportResult = { inserted: number; updated: number; changed: number; cancelled: number };

// ── 取り込みの記録（いつ・どのくらい取り込んだか） ──
// 「このデータは最新版か」を確認したい、というユーザー要望への対応。
// 予約行のupdated_atだけを見ると手動編集と区別が付かないため、専用の記録を残す。

export type ImportLogEntry = {
  id: string;
  importedAt: string;
  importedBy: string | null;
  insertedCount: number;
  updatedCount: number;
  dateFrom: string | null;
  dateTo: string | null;
};

function rowToImportLog(row: any): ImportLogEntry {
  return {
    id: row.id,
    importedAt: row.imported_at,
    importedBy: row.imported_by,
    insertedCount: row.inserted_count,
    updatedCount: row.updated_count,
    dateFrom: row.date_from,
    dateTo: row.date_to,
  };
}

/** 直近の取り込み記録。「これは最新のCSVか」の確認に使う */
export async function fetchLatestImportLog(): Promise<ImportLogEntry | null> {
  const { data, error } = await supabase
    .from('dispatch_imports')
    .select('*')
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToImportLog(data) : null;
}

async function recordImportLog(
  insertedCount: number,
  updatedCount: number,
  dateFrom: string,
  dateTo: string
): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const by = sessionData.session?.user?.email ?? null;
  const { error } = await supabase.from('dispatch_imports').insert({
    imported_by: by,
    inserted_count: insertedCount,
    updated_count: updatedCount,
    date_from: dateFrom,
    date_to: dateTo,
  });
  if (error) throw error;
}

/**
 * 既存行と取り込み行の照合キー。予約時刻（ミリ秒）＋電話番号の正規化値＋登録日時（ミリ秒）。
 *
 * 登録日時まで含めるのは、同じ時刻・同じ電話番号で複数台を別々に予約登録する
 * ケース（法人が同時刻に複数台を頼み、DS側で1台ずつ登録される等）があり、
 * 時刻・電話番号だけでは別々の予約を同じキーとみなして1件に潰してしまうため。
 * （2026-08-17に実際に発生：東北送配電サービス様の17:30予約3件が、登録日時が
 * 1分ずつ違うだけの別予約だったにもかかわらず1件に統合され、2件が消えた）
 */
function matchKey(reservedAt: string, phone: string | null, registeredAt: string | null): string {
  const registeredKey = registeredAt ? new Date(registeredAt).getTime() : '';
  return `${new Date(reservedAt).getTime()}|${normalizePhoneKey(phone)}|${registeredKey}`;
}

/**
 * 既存の予約と取り込み行で、DS由来の内容が同じか。
 *
 * DSのCSVは毎回すべての予約を書き出すため、取り込みのたびに大半の行が
 * 「一致した既存行」になる。中身が1文字も変わっていないものまで更新扱いにすると、
 * 本当に変わった予約が件数に埋もれて分からなくなる（ユーザーからの指摘）。
 * ここで同じと判定したものは、書き込みもせず「変更なし」として数える。
 *
 * 日時は文字列の形が違っても同じ時刻を指すことがある
 * （DBは "+00:00"、CSV由来は "....Z"）ため、必ず時刻値で比べる。
 */
function isSameDsContent(existing: Reservation, row: NormalizedRow): boolean {
  const sameTime = (a: string | null, b: string | null) => {
    if (!a || !b) return !a && !b;
    return new Date(a).getTime() === new Date(b).getTime();
  };
  // null と空文字は同じ意味として扱う（DSの空欄がどちらで入るかは経路次第のため）
  const sameText = (a: string | null, b: string | null) => (a ?? '') === (b ?? '');

  return sameTime(existing.reservedAt, row.reservedAt)
    && sameTime(existing.registeredAt, row.registeredAt)
    && existing.alarmMinutes === row.alarmMinutes
    && sameText(existing.officeName, row.officeName)
    && sameText(existing.customerName, row.customerName)
    && sameText(existing.customerKana, row.customerKana)
    && sameText(existing.phone, row.phone)
    && sameText(existing.reservationMemo, row.reservationMemo)
    && sameText(existing.operatorMemo, row.operatorMemo)
    && sameText(existing.pickupName, row.pickupName)
    && sameText(existing.pickupMemo, row.pickupMemo)
    && sameText(existing.pickupAddress, row.pickupAddress)
    && sameText(existing.dropoffName, row.dropoffName)
    && sameText(existing.dropoffAddress, row.dropoffAddress)
    && sameText(existing.registeredBy, row.registeredBy);
}

/** 表記ゆれ（前後・間の空白）を無視した比較用のお客様名 */
function normalizeCustomerName(name: string | null): string {
  return (name || '').replace(/[\s　]/g, '');
}

/**
 * 行き先メモの比較用正規化（オペレーター用メモ＋場所メモを結合）。
 * マッチの必須条件ではなく、電話番号・名前が一致する候補が複数ある場合に
 * どちらが「同じ予約」らしいかを判断する材料として使う。
 */
function normalizeMemoKey(r: { operatorMemo?: string | null; pickupMemo?: string | null }): string {
  return [r.operatorMemo, r.pickupMemo].filter(Boolean).join('').replace(/[\s　]/g, '');
}

/**
 * 「CSVから消えた＝キャンセル」と判定してよい猶予。予約時刻がこの時間より先の
 * ものだけを対象にする。
 *
 * DSのCSVは**配車が完了した予約を書き出さなくなる**（2026-08-19の実運用で判明。
 * 07:30と08:00の配車済み予約が2件、CSVから消えたためキャンセルと誤表示された）。
 * そのため、予約時刻を過ぎた・あるいは差し迫っている予約が消えるのは
 * 「キャンセルされた」ではなく「配車が終わった」を意味する。
 *
 * 配車はアラーム（実データで15〜30分前）の頃に行われるので、それを十分に覆う
 * 1時間を猶予とする。この範囲の予約は、CSVから消えても状態を変えない。
 * 代わりに、直前の本当のキャンセルは自動では拾えなくなる（人が手で付ける）。
 */
const CANCEL_DETECT_LEAD_MS = 60 * 60 * 1000;

/**
 * 取り込み前の差分計算。実際には書き込まない。
 * UIで「新規◯件・更新◯件」を見せてから確定させるために分けてある。
 */
export async function buildImportPlan(rows: NormalizedRow[]): Promise<ImportPlan> {
  if (rows.length === 0) {
    const today = todayJst();
    return { inserts: [], updates: [], missing: [], duplicatesInFile: 0, unchanged: 0, dateFrom: today, dateTo: today };
  }

  // ファイル内の重複は後勝ちで1件に寄せる
  const byKey = new Map<string, NormalizedRow>();
  let duplicatesInFile = 0;
  for (const r of rows) {
    const k = matchKey(r.reservedAt, r.phone, r.registeredAt);
    if (byKey.has(k)) duplicatesInFile++;
    byKey.set(k, r);
  }
  const unique = [...byKey.values()];

  const dates = unique.map((r) => jstDateKey(r.reservedAt)).sort();
  const dateFrom = dates[0];
  const dateTo = dates[dates.length - 1];

  const existing = await fetchReservationsRange(dateFrom, dateTo);
  const existingByKey = new Map<string, Reservation>();
  for (const e of existing) existingByKey.set(matchKey(e.reservedAt, e.phone, e.registeredAt), e);

  const inserts: ImportPlan['inserts'] = [];
  const updates: ImportPlan['updates'] = [];
  const matchedKeys = new Set<string>();
  let unchanged = 0;
  for (const [k, row] of byKey) {
    const hit = existingByKey.get(k);
    if (hit) {
      /*
       * 一致した時点で「今回のCSVにも居る」ことは確定なので、
       * 中身が同じかどうかに関わらず必ず matchedKeys に入れる。
       * ここを内容比較の内側に入れてしまうと、変更なしの予約が
       * 「CSVから消えた」と誤判定されてキャンセル扱いになる。
       */
      matchedKeys.add(k);
      if (isSameDsContent(hit, row)) {
        unchanged++;
      } else {
        updates.push({ id: hit.id, row, hasStaff: hit.staffId !== null });
      }
    } else {
      inserts.push({ ...row, tempId: `tmp-${inserts.length}` });
    }
  }

  /*
   * 消えた予約の検出：既存（CSV由来・まだ人がstatusを変えていないもの）のうち、
   * 今回のCSVのどのキーにもマッチしなかったもの。
   * すでに changed / cancelled になっている行は対象外
   * （二重処理を避け、既に人が判定したものを上書きしないため）。
   */
  const missing: MissingReservation[] = [];
  const usedInsertTempIds = new Set<string>();
  const cancelCutoff = Date.now() + CANCEL_DETECT_LEAD_MS;
  for (const [k, e] of existingByKey) {
    if (matchedKeys.has(k)) continue;
    if (e.source !== 'csv' || e.status !== 'normal') continue;
    // 配車済みの予約がキャンセルと誤判定されるのを防ぐ（定数のコメント参照）
    if (new Date(e.reservedAt).getTime() < cancelCutoff) continue;

    /*
     * 「時刻変更」候補として紐付けるのは、電話番号だけでなく
     * **お客様名も一致**する新規予約に限る。
     *
     * 電話番号だけで判定すると、施設の代表番号を複数のお客様が
     * 共有しているようなケースで、無関係な別人の予約同士を
     * 「同じ人の時刻変更」と誤って結び付けてしまう
     * （ユーザーから懸念の指摘があり追加した安全策）。
     * 名前まで一致すれば、その誤結合はほぼ起きない。
     *
     * 代わりに、電話番号は一致するが名前が違う（≒別人）場合は
     * 紐付けを諦め、単なる「キャンセル」として扱う。取りこぼしになるが、
     * 誤って他人の予約を変更あり扱いにするより安全な方に倒している。
     */
    const phoneKeyOfMissing = normalizePhoneKey(e.phone);
    const nameKeyOfMissing = normalizeCustomerName(e.customerName);
    const sameKeyCandidates = phoneKeyOfMissing
      ? inserts.filter((r) =>
          !usedInsertTempIds.has(r.tempId)
          && normalizePhoneKey(r.phone) === phoneKeyOfMissing
          && normalizeCustomerName(r.customerName) === nameKeyOfMissing
        )
      : [];

    let candidate: (typeof sameKeyCandidates)[number] | undefined;
    if (sameKeyCandidates.length === 1) {
      candidate = sameKeyCandidates[0];
    } else if (sameKeyCandidates.length > 1) {
      /*
       * 電話番号・名前が一致する候補が複数ある（同じ人が同日に複数件
       * 予約している等）。この場合はさらに判断材料を追加して絞り込む：
       *   1. 行き先メモ（オペレーター用メモ＋場所メモ）が一致するものを優先
       *   2. それでも決め手が無ければ、予約時刻が最も近いものを選ぶ
       *      （無関係な予約より、時刻が近い予約の方が「変更された」と
       *      考える方が自然なため）
       */
      const memoKeyOfMissing = normalizeMemoKey(e);
      candidate = memoKeyOfMissing
        ? sameKeyCandidates.find((r) => normalizeMemoKey(r) === memoKeyOfMissing)
        : undefined;
      if (!candidate) {
        const missingTime = new Date(e.reservedAt).getTime();
        candidate = [...sameKeyCandidates].sort(
          (a, b) =>
            Math.abs(new Date(a.reservedAt).getTime() - missingTime) -
            Math.abs(new Date(b.reservedAt).getTime() - missingTime)
        )[0];
      }
    }
    if (candidate) usedInsertTempIds.add(candidate.tempId);

    missing.push({
      id: e.id,
      customerName: e.customerName,
      reservedAt: e.reservedAt,
      matchedInsertId: candidate ? candidate.tempId : null,
    });
  }

  return { inserts, updates, missing, duplicatesInFile, unchanged, dateFrom, dateTo };
}

/**
 * 差分を実際に書き込む。
 *
 * 更新は DS由来のカラムだけを送る。staff_id / checked / app_memo / sort_order は
 * 触らないため、担当者を割り当てた後にCSVを入れ直しても割り当ては消えない。
 */
export async function applyImportPlan(plan: ImportPlan): Promise<ImportResult> {
  // tempId（プレビュー時の仮ID）→ 実際に発行されたDBの id
  const insertedIdByTempId = new Map<string, string>();

  if (plan.inserts.length > 0) {
    const payload = plan.inserts.map((r) => ({
      ...dsFields(r),
      reserved_date: jstDateKey(r.reservedAt), // NOT NULL制約のため。値はトリガーが上書きする
      source: 'csv',
    }));
    /*
     * 「変更あり」の予約から新しい予約へ矢印（superseded_by）を張るには、
     * どのtempIdがどの実idになったかを知る必要がある。まとめてinsertした
     * 戻り値の並び順が入力順と一致する保証は厳密には無いため、1件ずつ
     * insertしてidを確実に対応付ける（1日あたり数十件程度なので負荷は問題ない）。
     */
    const CONCURRENCY = 8;
    for (let i = 0; i < payload.length; i += CONCURRENCY) {
      const chunk = plan.inserts.slice(i, i + CONCURRENCY);
      const chunkPayload = payload.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunkPayload.map((p) => supabase.from(TABLE).insert(p).select('id').single())
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
      results.forEach((r, idx) => insertedIdByTempId.set(chunk[idx].tempId, r.data!.id));
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

  /*
   * 消えた予約の反映：同じ電話番号の新規予約と紐付いたもの（時刻変更の可能性）は
   * 「変更あり」、紐付かなかったもの（キャンセルの可能性）は「キャンセル」にする。
   * status列だけを更新し、DS由来のカラムには一切触れない。
   */
  const changed = plan.missing.filter((m) => m.matchedInsertId !== null);
  const cancelledIds = plan.missing.filter((m) => m.matchedInsertId === null).map((m) => m.id);
  if (changed.length > 0) {
    /*
     * superseded_by に新しい予約のidをセットする。「何が変わったか分からない」
     * 「新しい予約がどれか分からない」というユーザー指摘への対応（2026-08-19）。
     * matchedInsertId（tempId）は必ず insertedIdByTempId にある
     * （missingの候補選定は plan.inserts の中からしか選ばないため）。
     */
    const CONCURRENCY = 8;
    for (let i = 0; i < changed.length; i += CONCURRENCY) {
      const chunk = changed.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((m) => supabase.from(TABLE)
          .update({ status: 'changed', superseded_by: insertedIdByTempId.get(m.matchedInsertId!) ?? null })
          .eq('id', m.id))
      );
      const failed = results.find((r) => r.error);
      if (failed?.error) throw failed.error;
    }
  }
  if (cancelledIds.length > 0) {
    const { error } = await supabase.from(TABLE).update({ status: 'cancelled' }).in('id', cancelledIds);
    if (error) throw error;
  }

  // 取り込み自体は成功しているので、記録の失敗で全体を失敗扱いにはしない
  try {
    await recordImportLog(plan.inserts.length, plan.updates.length, plan.dateFrom, plan.dateTo);
  } catch (e) {
    console.error('取り込み記録の保存に失敗しました', e);
  }

  return {
    inserted: plan.inserts.length,
    updated: plan.updates.length,
    changed: changed.length,
    cancelled: cancelledIds.length,
  };
}

/** パーサ非依存の取り込み入口。将来DSコネクトのAPI連携に差し替える際はここを呼ぶ */
export async function importReservations(rows: NormalizedRow[]): Promise<ImportResult> {
  const plan = await buildImportPlan(rows);
  return applyImportPlan(plan);
}
