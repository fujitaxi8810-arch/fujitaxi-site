/**
 * 配車予約CSVの解析。
 *
 * 電脳交通「DS」から書き出したCSV、またはスプレッドシート「配車確認表」からの
 * 貼り付けテキストを、DBに入れられる形（NormalizedRow）に正規化する。
 *
 * 将来DSコネクトのAPIが使えるようになったら、このファイルの代わりに
 * APIレスポンスを NormalizedRow[] に変換する処理を書けば、
 * haisha-db.ts の importReservations はそのまま使える。
 */

/** DBに入れる直前の、列名解決済み・型変換済みの1行 */
export type NormalizedRow = {
  reservedAt: string; // ISO文字列
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
};

export type ParseResult = {
  rows: NormalizedRow[];
  /** 解決できた列（ヘッダー名 → フィールド名）。UIで「この列をこう読みました」を見せる用 */
  mapping: { field: string; header: string }[];
  /** 取り込めなかった行の理由。行番号は1始まり（ヘッダー行を除く） */
  errors: { line: number; reason: string }[];
};

// ── 文字コード ──

/**
 * DSの書き出しがShift_JISの可能性があるため、UTF-8で読めなければShift_JISで読み直す。
 * BOM付きUTF-8もそのまま扱える（parseDelimited側でBOMを落とす）。
 */
export function decodeCsvBuffer(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

// ── 区切りテキストの解析 ──

/**
 * 区切り文字を自動判定する。
 * スプレッドシートからコピーして貼り付けた場合はタブ区切りになるため、
 * カンマ区切りだけを前提にすると列がまるごとずれる。
 */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

/**
 * 引用符内のカンマ・改行・エスケープされた引用符（""）に対応した最小限のパーサ。
 * 住所やメモにカンマが入りうるため、単純なsplitでは壊れる。
 */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const delim = delimiter ?? detectDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delim) { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  return rows;
}

// ── ヘッダーの照合 ──

/** 全角英数を半角に、括弧を半角に、空白を除去して比較しやすくする */
function normalizeHeader(s: string): string {
  return s
    .replace(/^﻿/, '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/\s+/g, '')
    .trim();
}

type FieldKey = keyof NormalizedRow;

/**
 * 列の候補名。列位置ではなくヘッダー名で対応付ける
 * （実データで「読」「読み」の表記ゆれが確認されているため）。
 *
 * 注意: 「場所名」は「降車場所名」の部分文字列、「住所」は「降車住所」の部分文字列。
 * そのため部分一致は降車系を先に解決する（下の PARTIAL_ORDER）。
 */
const HEADER_CANDIDATES: Record<FieldKey, string[]> = {
  reservedAt:       ['予約日時'],
  alarmMinutes:     ['アラーム(分前)', 'アラーム'],
  officeName:       ['事業所名', '事業所'],
  customerName:     ['お客様名', '客様名', '顧客名', 'お客名'],
  customerKana:     ['読み', '読', 'カナ', 'ふりがな'],
  phone:            ['電話番号', '電話', 'TEL'],
  reservationMemo:  ['予約メモ'],
  operatorMemo:     ['オペレーター用メモ', 'オペレータ用メモ', 'オペレーターメモ'],
  pickupName:       ['場所名', '迎車場所名', '乗車場所名'],
  pickupMemo:       ['場所メモ', '迎車場所メモ'],
  pickupAddress:    ['住所', '迎車住所', '乗車住所'],
  dropoffName:      ['降車場所名', '降車場所'],
  dropoffAddress:   ['降車住所'],
  registeredAt:     ['登録日時'],
  registeredBy:     ['登録オペレーター', '登録オペレータ', '登録者'],
};

/** 部分一致で解決する順番。部分文字列を含む関係にある列を先に確定させる */
const PARTIAL_ORDER: FieldKey[] = [
  'reservedAt', 'registeredAt', 'alarmMinutes', 'officeName',
  'customerName', 'customerKana', 'phone',
  'reservationMemo', 'operatorMemo', 'registeredBy',
  'dropoffName', 'dropoffAddress',   // ← 降車系を先に
  'pickupMemo', 'pickupName', 'pickupAddress',
];

function resolveColumns(header: string[]): Partial<Record<FieldKey, number>> {
  const norm = header.map(normalizeHeader);
  const used = new Set<number>();
  const map: Partial<Record<FieldKey, number>> = {};

  // 1回目: 完全一致
  for (const field of PARTIAL_ORDER) {
    for (const cand of HEADER_CANDIDATES[field]) {
      const idx = norm.findIndex((h, i) => !used.has(i) && h === normalizeHeader(cand));
      if (idx !== -1) { map[field] = idx; used.add(idx); break; }
    }
  }

  // 2回目: 部分一致（降車系が先に確定しているので「場所名」が「降車場所名」を掴まない）
  for (const field of PARTIAL_ORDER) {
    if (map[field] !== undefined) continue;
    for (const cand of HEADER_CANDIDATES[field]) {
      const c = normalizeHeader(cand);
      const idx = norm.findIndex((h, i) => !used.has(i) && h.includes(c));
      if (idx !== -1) { map[field] = idx; used.add(idx); break; }
    }
  }

  return map;
}

// ── 値の変換 ──

/**
 * 「2026/08/06 7:30:00」「2026/8/6 7:30」等を日本時間として解釈し、ISO文字列にする。
 * ブラウザのタイムゾーンに依存しないよう +09:00 を明示して組み立てる。
 */
export function parseJstDateTime(raw: string): string | null {
  const s = (raw || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[/\-年](\d{1,2})[/\-月](\d{1,2})日?(?:[ 　T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0'] = m;
  const pad = (v: string, n = 2) => v.padStart(n, '0');
  const iso = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(sec)}+09:00`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/**
 * 電話番号の照合用の正規化。
 * スプレッドシートが数値として扱うと先頭の0が落ちるため（実データで確認済み:
 * 09067392619 → 9067392619）、数字以外を除去した上で先頭の0も落として比較する。
 */
export function normalizePhoneKey(raw: string | null): string {
  if (!raw) return '';
  return raw.replace(/\D/g, '').replace(/^0+/, '');
}

function text(v: string | undefined): string | null {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
}

// ── 本体 ──

export function parseReservationCsv(input: string): ParseResult {
  const table = parseDelimited(input).filter((r) => r.some((c) => c.trim() !== ''));
  if (table.length === 0) {
    return { rows: [], mapping: [], errors: [{ line: 0, reason: '中身が空です。' }] };
  }

  const header = table[0];
  const cols = resolveColumns(header);

  if (cols.reservedAt === undefined) {
    return {
      rows: [],
      mapping: [],
      errors: [{ line: 0, reason: '「予約日時」の列が見つかりません。ヘッダー行ごとコピーしているか確認してください。' }],
    };
  }
  if (cols.customerName === undefined) {
    return {
      rows: [],
      mapping: [],
      errors: [{ line: 0, reason: '「お客様名」の列が見つかりません。ヘッダー行ごとコピーしているか確認してください。' }],
    };
  }

  const mapping = (Object.keys(cols) as FieldKey[])
    .map((f) => ({ field: f, header: header[cols[f]!] ?? '' }));

  const at = (row: string[], key: FieldKey): string | undefined => {
    const idx = cols[key];
    return idx === undefined ? undefined : row[idx];
  };

  const rows: NormalizedRow[] = [];
  const errors: ParseResult['errors'] = [];

  for (let i = 1; i < table.length; i++) {
    const r = table[i];
    const line = i; // ヘッダーを除いた行番号

    const reservedAt = parseJstDateTime(at(r, 'reservedAt') ?? '');
    if (!reservedAt) {
      errors.push({ line, reason: `予約日時を読み取れません（"${(at(r, 'reservedAt') ?? '').trim()}"）` });
      continue;
    }
    const customerName = text(at(r, 'customerName'));
    if (!customerName) {
      errors.push({ line, reason: 'お客様名が空です' });
      continue;
    }

    const alarmRaw = (at(r, 'alarmMinutes') ?? '').replace(/[^\d]/g, '');

    rows.push({
      reservedAt,
      alarmMinutes: alarmRaw === '' ? null : Number(alarmRaw),
      officeName: text(at(r, 'officeName')),
      customerName,
      customerKana: text(at(r, 'customerKana')),
      phone: text(at(r, 'phone')),
      reservationMemo: text(at(r, 'reservationMemo')),
      operatorMemo: text(at(r, 'operatorMemo')),
      pickupName: text(at(r, 'pickupName')),
      pickupMemo: text(at(r, 'pickupMemo')),
      pickupAddress: text(at(r, 'pickupAddress')),
      dropoffName: text(at(r, 'dropoffName')),
      dropoffAddress: text(at(r, 'dropoffAddress')),
      registeredAt: parseJstDateTime(at(r, 'registeredAt') ?? ''),
      registeredBy: text(at(r, 'registeredBy')),
    });
  }

  return { rows, mapping, errors };
}
