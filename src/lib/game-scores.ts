/**
 * 「よけろ！タクシー」の全員共通ランキング。
 *
 * kintai/haishaと同じSupabaseプロジェクトに `game_scores` テーブルを
 * 1つ追加して使う（テーブル作成はユーザーがSupabaseダッシュボードで実行、
 * SQLは docs/game-scores-supabase.sql を参照）。
 *
 * kintai-db.ts とはあえてクライアントを共有していない。
 * ・こちらはお客様が匿名で触る、認証不要の軽いテーブル
 * ・kintai側の重い状態管理（管理者ログイン・オフライン検知など）を
 *   ゲームの読み込みに巻き込みたくない
 * という理由から独立させている。
 */
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY || '';

export const gameSupabase = createClient(supabaseUrl, supabaseAnonKey);

export type CarId = 'nv200' | 'jpn' | 'hansom';
const CAR_IDS: CarId[] = ['nv200', 'jpn', 'hansom'];

export interface ScoreRow {
  id: string;
  car: CarId;
  nickname: string;
  fare: number;
  created_at: string;
}

const NICKNAME_MAX = 12;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const RANK_LIMIT = 10;

/** JST（日本時間）での「今月」の範囲を求める。サーバーの時計に関わらず、
 *  お客様が実感する「今月」（日本時間の1日0:00〜翌月1日0:00）で区切る。 */
function currentMonthRangeJst(now = new Date()): { startIso: string; endIso: string; label: string } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const m = jst.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1) - JST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m + 1, 1) - JST_OFFSET_MS);
  return { startIso: start.toISOString(), endIso: end.toISOString(), label: y + '年' + (m + 1) + '月' };
}

/** 表示用：今月のラベル（例:「2026年9月」） */
export function currentMonthLabel(): string {
  return currentMonthRangeJst().label;
}

/** 全員に見える公開ランキングに出すには不適切な入力を弾く簡易フィルター。
 *  完全な検閲ではなく最低限の防止策（脅迫的な言葉・URL・メール・電話番号らしき並び）。
 *  すり抜けが見つかった場合は下の配列に追記していく。最終的な後始末は
 *  Supabaseダッシュボードからの手動削除に頼る（クライアントからの更新・削除は許可していない）。 */
const NG_PATTERNS: RegExp[] = [
  /死ね|殺す|消えろ|しね|ころす/i,                    // 脅迫・暴言
  /https?:\/\/|www\.|\.(com|jp|net|co)\b/i,          // URL（宣伝・スパム対策）
  /[\w.+-]+@[\w-]+\.[\w.-]+/,                        // メールアドレス
  /\d{2,4}[-‐]\d{2,4}[-‐]\d{4}/,                      // 電話番号らしき並び
];

/** ニックネームの前後の空白を落とし、長さを切り詰める。
 *  空、または不適切そうな入力のときは「なまえなし」にする（部分的な伏せ字にはしない）。 */
export function normalizeNickname(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return 'なまえなし';
  if (NG_PATTERNS.some((re) => re.test(trimmed))) return 'なまえなし';
  return trimmed.slice(0, NICKNAME_MAX);
}

/** 保存前の最終チェック。DB側のcheck制約と揃えている */
export function isValidScore(car: string, fare: number): car is CarId {
  return (CAR_IDS as string[]).includes(car) && Number.isFinite(fare) && fare >= 0 && fare <= 2_000_000;
}

/** 車種ごとの上位スコアを取る（今月分のみ。月が変わるとランキングもリセットされる） */
export async function fetchTopScores(
  car: CarId,
  limit = RANK_LIMIT
): Promise<{ ok: boolean; rows: ScoreRow[]; error?: string; monthLabel: string }> {
  const { startIso, endIso, label } = currentMonthRangeJst();
  try {
    const { data, error } = await gameSupabase
      .from('game_scores')
      .select('id, car, nickname, fare, created_at')
      .eq('game', 'dodge')
      .eq('car', car)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('fare', { ascending: false })
      .limit(limit);
    if (error) return { ok: false, rows: [], error: error.message, monthLabel: label };
    return { ok: true, rows: (data as ScoreRow[]) ?? [], monthLabel: label };
  } catch (e) {
    // 走行中の車内で電波が無い、などオフラインでも遊べなくならないようにする
    return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e), monthLabel: label };
  }
}

/** そのスコアが今月の上位ランキング（既定10位）に入りそうかどうかを調べる。
 *  「同じ車種・今月・このスコアより上の件数」が上位件数未満なら入る計算になる。 */
export async function wouldEnterRanking(
  car: CarId,
  fare: number,
  limit = RANK_LIMIT
): Promise<{ ok: boolean; enters: boolean; error?: string }> {
  const { startIso, endIso } = currentMonthRangeJst();
  try {
    const { count, error } = await gameSupabase
      .from('game_scores')
      .select('id', { count: 'exact', head: true })
      .eq('game', 'dodge')
      .eq('car', car)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .gt('fare', fare);
    if (error) return { ok: false, enters: false, error: error.message };
    return { ok: true, enters: (count ?? 0) < limit };
  } catch (e) {
    return { ok: false, enters: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** スコアを投稿する */
export async function submitScore(
  car: CarId,
  nickname: string,
  fare: number
): Promise<{ ok: boolean; error?: string }> {
  if (!isValidScore(car, fare)) return { ok: false, error: 'invalid score' };
  try {
    const { error } = await gameSupabase.from('game_scores').insert({
      game: 'dodge',
      car,
      nickname: normalizeNickname(nickname),
      fare: Math.round(fare),
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
