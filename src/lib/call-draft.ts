/**
 * 電話の仮予約 /haisha/call のデータ層と、文字起こしからの抜き出し・CSV予約との照合。
 *
 * 目的はお客様からの電話の漏れをなくすこと。DSへは自動で入れられない（API無し）ため、
 * 通話から「仮予約」を作り、DSのCSVを取り込んだときに同じ予約があるかを照合する。
 *
 * 決めごと（ユーザーと合意済み、2026-10-14）
 * - 文字起こしの全文は保存しない。残すのは予約の6項目（日時・お名前・迎車場所・お迎え先住所・目的地・台数）だけ
 * - 日時が読み取れない通話は予約ではないとみなし、保存しない
 * - 電話番号は聞かない運用（DS登録済みのお客様が多いため）。照合は
 *   「予約日時±10分」＋「DSの登録日時が通話より後」で行う
 * - 本物の予約（dispatch_reservations）は読むだけ。書き込み・削除は一切しない
 * - 試験中は本番の配車ボードに出さない（is_test。表示は /haisha/call のみ）
 */
import { supabase } from './kintai-db';
import { jstTimeLabel, type Reservation } from './haisha-db';

const TABLE = 'dispatch_call_drafts';

/** 保存期間。お名前・住所を含むため、これより古い仮予約は読み込み時に削除する */
export const RETENTION_DAYS = 7;

/**
 * - open      … 照合中（判定は毎回CSVの予約から計算する）
 * - confirmed … 人が「確認済み」にした（配車完了でCSVに出なくなった予約など）
 */
export type DraftStatus = 'open' | 'confirmed';

export type CallDraft = {
  id: string;
  calledAt: string;
  endedAt: string;
  /** 候補の日付（'YYYY-MM-DD'）。言及が無ければ通話日と翌日 */
  dates: string[];
  /** 候補の時刻（'HH:MM'）。午前/午後が言われていなければ両方 */
  times: string[];
  customerName: string | null;
  pickupPlace: string | null;
  pickupAddress: string | null;
  destination: string | null;
  carCount: number;
  status: DraftStatus;
};

export type DraftInput = Omit<CallDraft, 'id' | 'status'>;

function rowToDraft(row: any): CallDraft {
  return {
    id: row.id,
    calledAt: row.called_at,
    endedAt: row.ended_at,
    dates: row.dates ?? [],
    times: row.times ?? [],
    customerName: row.customer_name,
    pickupPlace: row.pickup_place,
    pickupAddress: row.pickup_address,
    destination: row.destination,
    carCount: row.car_count ?? 1,
    status: row.status ?? 'open',
  };
}

export async function fetchDraftsSince(sinceIso: string): Promise<CallDraft[]> {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .gte('called_at', sinceIso)
    .order('called_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(rowToDraft);
}

export async function insertDraft(d: DraftInput): Promise<CallDraft> {
  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      called_at: d.calledAt,
      ended_at: d.endedAt,
      dates: d.dates,
      times: d.times,
      customer_name: d.customerName,
      pickup_place: d.pickupPlace,
      pickup_address: d.pickupAddress,
      destination: d.destination,
      car_count: d.carCount,
      is_test: true,
    })
    .select('*')
    .single();
  if (error) throw error;
  return rowToDraft(data);
}

export async function setDraftStatus(id: string, status: DraftStatus): Promise<void> {
  const { error } = await supabase.from(TABLE).update({ status }).eq('id', id);
  if (error) throw error;
}

export async function deleteDraft(id: string): Promise<void> {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}

/** 保存期間を過ぎた仮予約を消す。失敗しても画面の動作には影響させない */
export async function purgeOldDrafts(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await supabase.from(TABLE).delete().lt('called_at', cutoff);
}

// ── 抜き出し ──

const KANJI_DIGIT: Record<string, number> = {
  '〇': 0, '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
};

/** 「十二」「三十」「五十九」程度の漢数字を数値にする（音声認識が漢数字で返すことがあるため） */
function kanjiToNumber(s: string): number | null {
  if (/^\d+$/.test(s)) return Number(s);
  if (!/^[〇零一二三四五六七八九十]+$/.test(s)) return null;
  if (!s.includes('十')) {
    let n = 0;
    for (const ch of s) n = n * 10 + KANJI_DIGIT[ch];
    return n;
  }
  const [tens, ones] = s.split('十');
  const t = tens === '' ? 1 : KANJI_DIGIT[tens] ?? NaN;
  const o = ones === '' ? 0 : KANJI_DIGIT[ones] ?? NaN;
  const n = t * 10 + o;
  return Number.isNaN(n) ? null : n;
}

/** 全角英数字・記号を半角に */
function toHalfWidth(s: string): string {
  return s.replace(/[０-９：－]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function jstParts(iso: string): { y: number; m: number; d: number; dow: number } {
  const t = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

function dateKeyOf(y: number, m: number, d: number): string {
  // Date.UTC は月日のあふれ（32日など）を繰り上げてくれる
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
}

function addDays(baseIso: string, days: number): string {
  const p = jstParts(baseIso);
  return dateKeyOf(p.y, p.m, p.d + days);
}

const NUM = '(\\d{1,2}|[〇零一二三四五六七八九十]{1,3})';
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
/** 場所の切れ目とみなす文字・言葉。「〜様」「〜分」「〜です」の後から場所が始まる */
const PLACE_BREAK = /^.*(?:[\s、。,.]|様|さま|分|時|半|です|ですね|でした|ね|は|へ|に|を|で|から|まで)/;

function lastWords(before: string): string | null {
  const s = before.slice(-16).replace(PLACE_BREAK, '').trim();
  return s.length >= 2 ? s : null;
}

/** 通話1件分の文字起こしから仮予約の項目を抜き出す。日時が読み取れなければ null（予約ではない） */
export function extractDraft(transcript: string, calledAt: string, endedAt: string): DraftInput | null {
  const text = toHalfWidth(transcript);
  const base = jstParts(calledAt);

  // ── 日付 ──
  const dates = new Set<string>();
  if (/今日|本日|きょう/.test(text)) dates.add(addDays(calledAt, 0));
  if (/明後日|あさって/.test(text)) dates.add(addDays(calledAt, 2));
  if (/明日|あした|あす/.test(text.replace(/明後日/g, ''))) dates.add(addDays(calledAt, 1));
  const MD = new RegExp(`${NUM}月${NUM}日`, 'g');
  for (const mt of text.matchAll(MD)) {
    const mo = kanjiToNumber(mt[1]);
    const d = kanjiToNumber(mt[2]);
    if (!mo || !d || mo > 12 || d > 31) continue;
    // 12月に1月の予約を受けた場合は翌年
    dates.add(dateKeyOf(mo < base.m ? base.y + 1 : base.y, mo, d));
  }
  for (const mt of text.replace(MD, '').matchAll(new RegExp(`${NUM}日(?!間)`, 'g'))) {
    const d = kanjiToNumber(mt[1]);
    if (!d || d > 31) continue;
    dates.add(dateKeyOf(base.y, d < base.d ? base.m + 1 : base.m, d));
  }
  for (const mt of text.matchAll(/([日月火水木金土])曜/g)) {
    const diff = (WEEKDAYS.indexOf(mt[1]) - base.dow + 7) % 7;
    dates.add(addDays(calledAt, diff));
    // 同じ曜日なら「今日」とも「来週」とも取れるので両方を候補にする
    if (diff === 0) dates.add(addDays(calledAt, 7));
  }
  if (dates.size === 0) {
    dates.add(addDays(calledAt, 0));
    dates.add(addDays(calledAt, 1));
  }

  // ── 時刻 ──
  const times = new Set<string>();
  const pushTime = (h: number, min: number, period: string | undefined) => {
    if (h > 24 || min > 59) return;
    const fmt = (x: number) => String(x % 24).padStart(2, '0') + ':' + String(min).padStart(2, '0');
    if (period && /午後|夕方|夜|晩/.test(period)) times.add(fmt(h < 12 ? h + 12 : h));
    else if (period) times.add(fmt(h));
    else {
      times.add(fmt(h));
      if (h >= 1 && h <= 11) times.add(fmt(h + 12));
    }
  };
  for (const mt of text.matchAll(new RegExp(`(午前|午後|朝|夕方|夜|晩)?の?\\s*${NUM}時(?!間)(?:\\s*(半)|\\s*${NUM}分)?`, 'g'))) {
    const h = kanjiToNumber(mt[2]);
    if (h === null) continue;
    pushTime(h, mt[3] ? 30 : mt[4] ? kanjiToNumber(mt[4]) ?? 0 : 0, mt[1]);
  }
  for (const mt of text.matchAll(/(午前|午後|朝|夕方|夜|晩)?\s*(\d{1,2}):(\d{2})/g)) {
    pushTime(Number(mt[2]), Number(mt[3]), mt[1]);
  }
  if (times.size === 0) return null;

  // ── お名前（漢字・カタカナ＋様。ひらがなは前の言葉との区切りが判別できないため拾わない） ──
  let customerName: string | null = null;
  // 法人名（「東北送配電サービス様」）もあるので長めに取り、前に付いた日付の言葉は外す
  for (const mt of text.matchAll(/([一-龥々ァ-ヶー]{1,16})(?:様|さま)/g)) {
    const n = mt[1].replace(/^(本日|今日|明日|明後日|毎週|毎日)/, '');
    if (n === '' || /^(客|皆|奥|旦那|先|子|家族|患者|利用者|運転手)$/.test(n)) continue;
    customerName = n;
    break;
  }

  // ── 台数（「2台」。「高台」「仙台」のような地名を拾わないよう数字の直後だけ） ──
  let carCount = 1;
  const cars = text.match(/(\d{1,2}|[一二三四五六七八九十]{1,2})台/);
  if (cars) {
    const n = kanjiToNumber(cars[1]);
    if (n && n >= 1 && n <= 20) carCount = n;
  }

  // ── お迎え先住所（「原町区仲町2丁目3番地」） ──
  let pickupAddress: string | null = null;
  const ADDR_NUM = '(?:\\d+|[〇一二三四五六七八九十]+)';
  const addr =
    text.match(new RegExp(`(?:南相馬市)?(?:原町区|鹿島区|小高区)[^\\s、。]{0,12}?${ADDR_NUM}(?:丁目|番地|番|号)(?:${ADDR_NUM}(?:番地|番|号|の)?|-)*`)) ??
    text.match(new RegExp(`[一-龥ァ-ヶー]{1,6}${ADDR_NUM}丁目(?:${ADDR_NUM}(?:番地|番|号|の)?|-)*`));
  if (addr) pickupAddress = addr[0].replace(/[-の]+$/, '');

  // ── 迎車場所（「〜から」「〜にお迎え」）・目的地（「〜まで」「行き先は〜」） ──
  const textNoAddr = pickupAddress ? text.replace(pickupAddress, ' ') : text;
  let pickupPlace: string | null = null;
  const pickupMt = textNoAddr.match(/^(.*?)(?:から|にお迎え|へお迎え|に迎え)/);
  if (pickupMt) pickupPlace = lastWords(pickupMt[1]);

  let destination: string | null = null;
  const destMt = textNoAddr.match(/(?:行き先は|行先は|目的地は)\s*([^\s、。]{2,16}?)(?:です|まで|で|ね|[\s、。]|$)/);
  if (destMt) destination = destMt[1];
  else {
    const untilMt = textNoAddr.match(/^(.*?)まで/);
    if (untilMt) destination = lastWords(untilMt[1]);
  }

  return {
    calledAt,
    endedAt,
    dates: [...dates].sort(),
    times: [...times].sort(),
    customerName,
    pickupPlace,
    pickupAddress,
    destination,
    carCount,
  };
}

/** 画面に出す代表の日時。候補のうち通話より後で一番近いもの（「3時」なら15時を優先する、など） */
export function primaryDateTime(d: Pick<CallDraft, 'dates' | 'times' | 'calledAt'>): { date: string; time: string } | null {
  const call = new Date(d.calledAt).getTime();
  let best: { date: string; time: string; at: number } | null = null;
  for (const date of d.dates) {
    for (const time of d.times) {
      const at = new Date(`${date}T${time}:00+09:00`).getTime();
      if (at < call) continue;
      if (!best || at < best.at) best = { date, time, at };
    }
  }
  if (best) return { date: best.date, time: best.time };
  return d.dates.length && d.times.length ? { date: d.dates[0], time: d.times[0] } : null;
}

// ── 照合 ──

/** 時刻が近いとみなす幅（分）。言い間違い・DS側での丸めを吸収する */
const TIME_TOLERANCE_MIN = 10;
/** DSの登録日時が通話開始より少し前でも許す幅（通話中にDSへ入力した場合など） */
const REGISTER_BEFORE_SLACK_MS = 5 * 60 * 1000;
/** 通話からこの時間以内にDSへ登録された予約だけを対象にする */
const REGISTER_WITHIN_MS = 24 * 60 * 60 * 1000;

export type DraftLevel =
  | 'matched'    // CSVに台数分の予約がある（白）
  | 'partial'    // 台数の一部だけある（黄）
  | 'ambiguous'  // 候補が複数あって決めきれない（黄）
  | 'missing'    // 通話後にCSVを取り込んだのに見当たらない（赤）
  | 'waiting';   // 通話後にまだCSVを取り込んでいない（赤・取り込み待ち）

export type DraftJudgement = {
  draft: CallDraft;
  level: DraftLevel;
  /** matched/partial なら一致した予約、ambiguous なら候補 */
  reservations: Reservation[];
};

function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function norm(s: string | null | undefined): string {
  return (s ?? '').replace(/[\s　]/g, '');
}

/** お名前・迎車場所・住所の一致で候補に点数を付ける（同じ時刻の別のお客様と区別するため） */
function score(d: CallDraft, r: Reservation): number {
  let s = 0;
  const name = norm(d.customerName);
  if (name && (norm(r.customerName).includes(name) || norm(r.customerKana).includes(name))) s += 2;
  const pickupHay = norm([r.pickupName, r.pickupMemo, r.pickupAddress, r.operatorMemo].join(''));
  const place = norm(d.pickupPlace);
  if (place && pickupHay.includes(place)) s += 1;
  const addr = norm(d.pickupAddress);
  if (addr && pickupHay.includes(addr.slice(0, 6))) s += 1;
  return s;
}

/**
 * 仮予約ごとにCSV予約との一致を判定する。
 * 1つのCSV予約が2件の仮予約に使われると漏れが隠れるため、受電の早い順に割り当て、使った予約は除外する。
 * 迷うときは消さない（ambiguous）方に倒す：誤って一致扱いにすると漏れを見逃すため。
 */
export function judgeDrafts(drafts: CallDraft[], reservations: Reservation[], lastImportAt: string | null): DraftJudgement[] {
  const used = new Set<string>();
  const live = reservations.filter((r) => r.status !== 'cancelled' && r.registeredAt);
  const ordered = [...drafts].sort((a, b) => a.calledAt.localeCompare(b.calledAt));
  const out = new Map<string, DraftJudgement>();

  for (const d of ordered) {
    const call = new Date(d.calledAt).getTime();
    const cands = live
      .filter((r) => {
        if (used.has(r.id) || !d.dates.includes(r.reservedDate)) return false;
        const reg = new Date(r.registeredAt!).getTime();
        if (reg < call - REGISTER_BEFORE_SLACK_MS || reg > call + REGISTER_WITHIN_MS) return false;
        const t = minutesOfDay(jstTimeLabel(r.reservedAt));
        return d.times.some((h) => Math.abs(minutesOfDay(h) - t) <= TIME_TOLERANCE_MIN);
      })
      .map((r) => ({ r, s: score(d, r) }))
      .sort((a, b) => b.s - a.s);

    const imported = !!lastImportAt && new Date(lastImportAt).getTime() >= new Date(d.endedAt).getTime();
    const need = d.carCount;
    let level: DraftLevel;
    let picked: Reservation[] = [];

    if (cands.length === 0) {
      level = imported ? 'missing' : 'waiting';
    } else if (cands.length < need) {
      level = 'partial';
      picked = cands.map((c) => c.r);
    } else if (cands.length === need || cands[need - 1].s > cands[need].s) {
      level = 'matched';
      picked = cands.slice(0, need).map((c) => c.r);
    } else {
      level = 'ambiguous';
      picked = cands.map((c) => c.r);
    }

    if (level === 'matched' || level === 'partial') picked.forEach((r) => used.add(r.id));
    out.set(d.id || d.calledAt, { draft: d, level, reservations: picked });
  }
  return drafts.map((d) => out.get(d.id || d.calledAt)!);
}
