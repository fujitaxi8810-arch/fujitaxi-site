# 勤怠管理システム Supabase移行 実装仕様書

**作成日:** 2026-07-17（設計: Claude Fable 5 / 実装担当: Claude Sonnet セッション）
**対象:** `src/pages/kintai.astro`（社内用勤怠管理アプリ）のデータ層を localStorage から Supabase に移行する

---

## 0. この仕様書の読み方（実装セッションへ）

- この文書は**単体で完結**するよう書かれている。過去の会話ログは参照不要。
- 「決定済み」と書かれた設計判断は再検討せず従うこと。
- 給与計算ロジック・UI挙動は**現行の kintai.astro と完全に同一**に保つ。この文書の第2章が現行仕様の正であり、実装後は第8章の検証チェックリスト（ゴールデン値）で一致を確認する。
- ユーザー（会社側）が Supabase ダッシュボードで行う手作業は第7章にまとめてある。実装前にユーザーへ第7章の作業を依頼し、URL / anon key を受け取ること。

---

## 1. 背景と目的

### 現状の構成
- Astro 4 静的サイト（`fuji-taxi` リポジトリ）→ GitHub push で Vercel に自動デプロイ
- `/kintai` は完全クライアントサイド。データはすべて **localStorage**:
  - `fuji-kintai-staff` … スタッフ一覧（名前・区分・時給等）
  - `fuji-kintai-log` … 打刻レコード（1人1日1件）
  - `fuji-kintai-settings` … 給与設定＋管理者パスワード
  - `fuji-kintai-migrated-*` … 端末ごとのデータ修正フラグ（多数）
  - sessionStorage `fuji-kintai-admin` … 管理者ロック解除状態

### 問題点（移行の動機）
1. データが端末ごとに分断され、同期・バックアップがない
2. スタッフ設定の変更を「コード内のマイグレーション」として配布する運用になっており、端末ごとの表記ゆれ（例: 氏名の異体字）で不具合が多発した
3. 従業員に紐づく給与計算を今後拡張するには一元的なDBが必要

### 目的
- **Supabase（Postgres + Auth + RLS）をデータソースに**し、どの端末からも同じデータを参照・更新できるようにする
- スタッフマスタ・打刻・売上・給与設定をDBで一元管理
- UI・給与計算ロジック・Excel/CSV出力は**現行のまま**（データの読み書き先だけを差し替える）

---

## 2. 現行仕様（この内容を変えずに移植する）

### 2.1 雇用区分と給与計算

区分は5種類。`type` フィールドの値と計算式:

| type | 表示名 | 総支給額の計算 |
|---|---|---|
| `fulltime` | 正社員 | シフト日給 ＋ 電話番手当 ＋ 歩合給 ＋ 交通費 |
| `fulltime-base` | 正社員（基本給のみ） | シフト日給（個人固定日給があればそれ） ＋ 電話番手当 ＋ 交通費。**歩合なし・売上入力UI非表示** |
| `fulltime-hourly` | 正社員（時給） | 時給×実働 ＋ 残業割増 ＋ 深夜割増 ＋ 交通費 |
| `part` | パート | 同上（時給制） |
| `monthly` | 正社員（月給） | 月給（固定） ＋ 交通費。日別金額は0円表示・時給換算/最低賃金判定の対象外 |

**共通設定値**（settings、現行デフォルト）:
- 普通番 基本日給 `normalWage` = 8400
- 遅番 基本日給 `lateWage` = 8400、遅番割増 `lateBonus` = 700（遅番日給 = 8400+700）
- 電話番手当 `phoneAllowance` = 300
- 歩合率 `commissionRate` = 16.57（%）
- 最低賃金 `minWage` = 1033（福島県、確認用）
- 残業割増率 `OT_RATE` = 0.25（8時間超）、深夜割増率 `NIGHT_RATE` = 0.25、深夜開始 22時（コード定数）

**計算式（丸め含め厳密に同一にすること）**:

```
実働分 workMinutes = (退勤 − 出勤) − Σ休憩 − Σ時間内外出   （ms→分, Math.round, 負なら0）
シフト日給 shiftWage:
  shiftType が 'part' または未設定 → 0
  個人固定日給 dailyWage があれば w = dailyWage（普通番/遅番どちらでも同額）
  なければ w = (遅番 ? lateWage+lateBonus : normalWage)
  phoneDuty なら w += phoneAllowance
歩合 commissionPay = max(0, sales − cardFee) × commissionRate/100   （salesは税抜, 型はfloat）
深夜分 nightMinutes = max(0, 退勤時刻 − その日の22:00) を分で（退勤時刻ベースの近似。休憩は考慮しない）

payParts(rec):
  commute = 出勤していれば rec.commute（日額）else 0
  時給制（part / fulltime-hourly）:
    base  = round(時給 × 実働分/60)
    ot    = round(max(0, 実働分/60 − 8) × 時給 × 0.25)
    night = round(nightMinutes/60 × 時給 × 0.25)
    extra = ot + night + commute
  それ以外:
    base  = shiftWage(rec)
    commission = type==='fulltime' ? commissionPay(rec) : 0
    extra = commission + commute
totalPay = base + extra
時給換算 hourlyRate = totalPay / (実働分/60)。monthly は常に null（対象外）
最低賃金判定 = hourlyRate < minWage → 履歴行を赤（.kt-table__row--warn）＋⚠️表示
月次サマリーの基本給列: monthly のみ「月給そのもの」を表示（日別baseの合計ではない）
```

**打刻時スナップショット**: 出勤打刻の瞬間に、スタッフマスタの `empType, hourlyWage, monthlyWage, dailyWage, commuteAllowance(→commute)` をレコードへコピーする。後からマスタを変更しても過去の給与は変わらない。表示・計算はレコードのスナップショット優先、無ければマスタの現在値でフォールバック。

### 2.2 売上入力（管理者・fulltime のみ）

- 入力は**税込** `salesGross`。保存時に `sales = round(salesGross / 1.1)`（税抜、歩合計算に使用）
- **未収** `uncollected`（掛け・請求書等。歩合計算に影響しない）
- 決済方法ごとの内訳 `payments`（金額）→ カード手数料 `cardFee` を自動計算（手修正欄あり、手修正が優先）
- 手数料率（%）初期値（SBペイメント2026年6月実績）:
  `visa` 2.8 / `jcb` 3.24 / `transit` 2.0 / `emoney` 2.9 / `quicpay` 3.24 / `rakuten` 3.39 / `paypay` 2.18 / `dbarai` 2.6 / `merpay` 2.6 / `aiticket` 5 / `jcbticket` 4
- 内訳合計 > 売上合計 のとき confirm で警告

### 2.3 打刻フロー・UI挙動

- スタッフはチップをタップで選択、**再タップで選択解除**
- 正社員（fulltime / fulltime-base）: ①電話番チェック → ②普通番/遅番ボタン。
  - `phoneDutyDisabled` のスタッフは①ブロック非表示（出勤レコードの phoneDuty も強制false）
  - `lateShiftDisabled` のスタッフは遅番ボタン非表示（グリッド1列化 `.kt-shift-grid--single`）
- 時給制・月給制（part / fulltime-hourly / monthly）: シフト選択なしの単一「出勤」ボタン（`shiftType='part'` で記録）
- 出勤後: 退勤 / 休憩開始・終了 / 時間内退勤・時間内出勤（leaves）
- **選択中ラベルの簡略表示**: fulltime-hourly / monthly / fulltime-base は「（正社員）」とだけ表示。履歴・サマリー・CSV・Excelでは正式区分名（正社員（時給）等）を表示
- 管理者ロック: 解除中のみ表示 … 勤務履歴パネル・月次給与サマリー・給与設定・全打刻データ削除・Excel連携ボックス・スタッフチップの✎/×アイコン・金額（ロック中は `••••` マスク）
- 管理者ロックバーはページ**下部**（「本日の状況」の後、勤務履歴の前）に配置
- レイアウト: `.kintai-wrap` max-width 1280px、ヘッダー時計はコンパクト（時計+スタッフ一覧が1画面に収まる）

### 2.4 出力機能（ロジック変更なし・データ取得元のみ差し替え）

1. **CSV出力**（月次）: 日別明細＋設定値＋月次サマリー。列: 日付,名前,区分,電話番,出勤,退勤,休憩(分),時間内外出(分),実働(分),実働(時:分),売上税込(円),売上税抜(円),未収(円),カード手数料等(円),基本給(円),歩合・手当(円),合計支給額(円),時給換算(円),最低賃金判定,＋決済方法別列
2. **給与計算Excel出力**: SheetJS(CDN xlsx@0.18.5)でタイムカード形式ブック生成（設定/全体集計/スタッフ別シート/使い方）。数式セルはダミー `v:0` 必須（SheetJSはvなしの数式セルを書き出さない）。区分ごとにシートレイアウトが異なる（正社員/時給制/月給制）
3. **Excel自動追記**（File System Access API で「CSV貼り付け」シートへ追記）: 現行機能を維持

### 2.5 スタッフマスタ（現在の16名・シード値）

氏名は**姓と名の間に全角スペース**で表示する（実端末の表記に合わせる）。名前照合が必要な場面では必ず空白除去で正規化すること。

| 氏名 | type | 時給 | 月給 | 固定日給 | 交通費/日 | 電話番非表示 | 遅番非表示 |
|---|---|---|---|---|---|---|---|
| 小林　清美 | fulltime | — | — | — | 3000 | ✓ | ✓ |
| 渡部　晃 | fulltime | — | — | — | 0 | | |
| 渋佐　繁男 | fulltime | — | — | — | 0 | ✓ | ✓ |
| 菊地　勝治 | fulltime-base | — | — | 8000 | 0 | ✓ | ✓ |
| 堀内　洋伯 | fulltime | — | — | — | 0 | | |
| 佐藤　賀子 | fulltime-hourly | 1200 | — | — | 1000 | ✓ | （時給制のため元々なし） |
| 小林　結 | fulltime | — | — | — | 0 | ✓ | ✓ |
| 須江　浩子 | part | 1033 | — | — | 1061 | ✓ | — |
| 佐藤　文枝 | part | 1033 | — | — | 376 | ✓ | — |
| 菅原　元輝 | fulltime | — | — | — | 0 | | |
| 池内　昌信 | fulltime | — | — | — | 3000 | ✓ | |
| 荒　智章 | fulltime | — | — | — | 3000 | | |
| 中橋　常郎 | part | 1050 | — | — | 3000 | ✓ | — |
| 石川　美紀 | fulltime | — | — | — | 0 | | |
| 小林　聖人 | monthly | — | 300000 | — | 0 | ✓ | — |
| 目黒　圭吾 | fulltime | — | — | — | 0 | | |

※ 打刻履歴は移行しない（ユーザーが全削除の意向を示しており、新システムはゼロスタート）。

---

## 3. 決定済みのアーキテクチャ

- **Supabase**（無料枠、リージョン: Tokyo）。Postgres + Auth + RLS。Realtime は任意（第6章）
- Astro は**静的サイトのまま**。`@supabase/supabase-js` v2 を npm 依存に追加し、ブラウザから直接 Supabase に接続（サーバーコード追加なし）
- 認証は **2アカウント方式**:
  - `kiosk`（端末常用）: 打刻の読み書きのみ。端末に一度ログインすればセッション永続
  - `admin`（管理者）: 全操作。現在の「管理者ロック解除」ボタンを **adminへのログイン** に置き換える（パスワード prompt → Supabase Auth サインイン）。「ロックする」で kiosk セッションに戻す
  - 権限判定は `app_metadata.role = 'admin'`（JWT内）を RLS で参照
- 金額の閲覧マスク（`••••`）は現行同様**クライアント側**で行う（列レベルのDB秘匿は将来課題として第6章に記載。現行パリティ優先）
- localStorage の `fuji-kintai-*` および全マイグレーションコードは**削除**（DBが正となるため不要）。ただし書き込み失敗時のエラー通知は必須（第5.4）

---

## 4. データベース設計（このSQLをそのまま Supabase SQL Editor で実行）

```sql
-- ========== テーブル ==========
create table staff (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  display_order int not null default 0,
  emp_type text not null default 'fulltime'
    check (emp_type in ('fulltime','fulltime-base','fulltime-hourly','part','monthly')),
  hourly_wage int,
  monthly_wage int,
  daily_wage int,
  commute_allowance int not null default 0,
  phone_duty_disabled boolean not null default false,
  late_shift_disabled boolean not null default false,
  is_active boolean not null default true,   -- ×での「削除」は is_active=false（履歴保持）
  created_at timestamptz not null default now()
);

create table attendance (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references staff(id),
  work_date date not null,
  clock_in timestamptz,
  clock_out timestamptz,
  shift_type text check (shift_type in ('normal','late','part')),
  phone_duty boolean not null default false,
  breaks jsonb not null default '[]',   -- [{"start": iso, "end": iso|null}]
  leaves jsonb not null default '[]',
  -- 出勤時スナップショット
  emp_type text,
  hourly_wage int,
  monthly_wage int,
  daily_wage int,
  commute int,
  -- 売上（管理者入力）
  sales_gross int,
  sales int,
  uncollected int,
  card_fee int,
  payments jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  unique (staff_id, work_date)
);
create index attendance_month_idx on attendance (work_date);

create table settings (
  id int primary key default 1 check (id = 1),   -- 1行のみ
  normal_wage int not null default 8400,
  late_wage int not null default 8400,
  late_bonus int not null default 700,
  phone_allowance int not null default 300,
  commission_rate numeric not null default 16.57,
  min_wage int not null default 1033,
  fee_rates jsonb not null default '{
    "visa":2.8,"jcb":3.24,"transit":2.0,"emoney":2.9,"quicpay":3.24,
    "rakuten":3.39,"paypay":2.18,"dbarai":2.6,"merpay":2.6,
    "aiticket":5,"jcbticket":4}'
);
insert into settings (id) values (1);

-- ========== updated_at 自動更新 ==========
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;
create trigger attendance_touch before update on attendance
  for each row execute function touch_updated_at();

-- ========== RLS ==========
alter table staff enable row level security;
alter table attendance enable row level security;
alter table settings enable row level security;

create or replace function is_admin() returns boolean as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$ language sql stable;

-- staff: 認証済みなら閲覧可。変更は admin のみ
create policy staff_select on staff for select to authenticated using (true);
create policy staff_admin_write on staff for all to authenticated
  using (is_admin()) with check (is_admin());

-- attendance: 認証済みなら閲覧・打刻（insert/update）可。削除は admin のみ
-- ※売上列の更新も kiosk 権限で技術的には可能だが、UI上は管理者ログイン中のみ。現行パリティ。
create policy att_select on attendance for select to authenticated using (true);
create policy att_insert on attendance for insert to authenticated with check (true);
create policy att_update on attendance for update to authenticated using (true);
create policy att_admin_delete on attendance for delete to authenticated using (is_admin());

-- settings: 閲覧は認証済み全員、更新は admin のみ
create policy settings_select on settings for select to authenticated using (true);
create policy settings_admin_update on settings for update to authenticated
  using (is_admin()) with check (is_admin());

-- ========== スタッフ初期データ ==========
insert into staff (name, display_order, emp_type, hourly_wage, monthly_wage, daily_wage,
                   commute_allowance, phone_duty_disabled, late_shift_disabled) values
('小林　清美',  1, 'fulltime',        null, null, null, 3000, true,  true),
('渡部　晃',    2, 'fulltime',        null, null, null,    0, false, false),
('渋佐　繁男',  3, 'fulltime',        null, null, null,    0, true,  true),
('菊地　勝治',  4, 'fulltime-base',   null, null, 8000,    0, true,  true),
('堀内　洋伯',  5, 'fulltime',        null, null, null,    0, false, false),
('佐藤　賀子',  6, 'fulltime-hourly', 1200, null, null, 1000, true,  false),
('小林　結',    7, 'fulltime',        null, null, null,    0, true,  true),
('須江　浩子',  8, 'part',            1033, null, null, 1061, true,  false),
('佐藤　文枝',  9, 'part',            1033, null, null,  376, true,  false),
('菅原　元輝', 10, 'fulltime',        null, null, null,    0, false, false),
('池内　昌信', 11, 'fulltime',        null, null, null, 3000, true,  false),
('荒　智章',   12, 'fulltime',        null, null, null, 3000, false, false),
('中橋　常郎', 13, 'part',            1050, null, null, 3000, true,  false),
('石川　美紀', 14, 'fulltime',        null, null, null,    0, false, false),
('小林　聖人', 15, 'monthly',         null, 300000, null,  0, true,  false),
('目黒　圭吾', 16, 'fulltime',        null, null, null,    0, false, false);
```

---

## 5. 実装計画（ファイル別）

### 5.1 依存・環境変数

- `npm install @supabase/supabase-js`
- `.env`（ローカル）と Vercel の Environment Variables に:
  - `PUBLIC_SUPABASE_URL`
  - `PUBLIC_SUPABASE_ANON_KEY`
- `.env` を `.gitignore` に含める（既に含まれているか確認）。`.env.example` を追加

### 5.2 新規ファイル `src/lib/kintai-db.ts`（データ層）

kintai.astro の script から import する薄いモジュール。責務:

```ts
export const supabase = createClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY);

// 認証
ensureKioskSession(): Promise<void>      // セッションなければ kiosk で signInWithPassword
signInAdmin(email, password): Promise<boolean>
signOutToKiosk(): Promise<void>          // admin → kiosk に戻す
isAdmin(): boolean                        // 現セッションの app_metadata.role === 'admin'

// データ
fetchStaff(): Promise<Staff[]>            // is_active=true, display_order順
fetchSettings(): Promise<Settings>
fetchMonth(month: 'YYYY-MM'): Promise<Attendance[]>
fetchToday(): Promise<Attendance[]>
upsertAttendance(rec): Promise<Attendance>   // unique(staff_id, work_date) でupsert
updateStaff(id, patch) / insertStaff(s) / deactivateStaff(id)   // admin用
updateSettings(patch)
```

- kiosk の資格情報はコードに直書きせず、**初回起動時に端末で入力→localStorage に保存**する方式（`fuji-kintai-kiosk-cred`）。supabase-js のセッション永続で通常は再入力不要
- 命名変換: DB snake_case ↔ アプリ内 camelCase はこのモジュール内で吸収し、kintai.astro 側の既存プロパティ名（`hourlyWage`, `commuteAllowance`, `phoneDutyDisabled`, `lateShiftDisabled`, `salesGross` 等）を維持する（UI側の変更量を最小化）

### 5.3 `src/pages/kintai.astro` の変更

1. **削除**: localStorage 読み書き（LS_STAFF/LS_LOG/LS_SETTINGS）、全 `fuji-kintai-migrated-*` マイグレーションブロック、DEFAULT_STAFF_NAMES / DEFAULT_EMP シード、adminPassword 関連（requireAdmin の prompt 方式）
2. **置換**:
   - 起動時: `ensureKioskSession()` → `fetchStaff()/fetchSettings()/fetchToday()` → 描画。ロード中表示（「読み込み中…」）とエラー表示を追加
   - 打刻系（punchIn / punch('out'|'breakStart'|…)）: メモリ上の rec を更新→ `upsertAttendance` → 成功後に再描画。**失敗時は alert で明示**（5.4）
   - 売上保存 / 給与設定保存 / スタッフ✎編集・×削除・＋追加: 対応するDB関数へ
   - 管理者ロック解除: モーダルまたは prompt でメール&パスワード → `signInAdmin`。ロック: `signOutToKiosk`
   - 履歴・サマリー: `fetchMonth(currentMonth())` の結果から現行と同じ計算・描画（計算関数 payParts/shiftWage/workMinutes 等は**そのまま流用**）
3. **維持**: CSV出力・給与計算Excel出力・Excel自動追記・印刷系・全UI/CSS（変更禁止。データ取得元だけ差し替え）
4. 「🗑 全打刻データを削除」: admin のみ。`delete from attendance`（二重confirmは現行どおり）

### 5.4 エラー・オフライン方針（最小限）

- すべてのDB書き込みは await し、失敗時に `alert('通信エラーで保存できませんでした。電波状況を確認してもう一度お試しください。')` を出す。**サイレント失敗は禁止**（打刻消失が最悪の障害）
- 楽観的更新はしない（保存成功後に再描画）。打刻ボタンは保存完了まで disabled にして二重送信を防ぐ
- オフラインキュー・Realtime同期は初期実装ではやらない（第6章）

---

## 6. 将来課題（今回は実装しない・仕様として記録のみ)

- Realtime購読による「本日の状況」の多端末ライブ更新
- 売上・給与列の列レベル秘匿（kiosk用ビュー分離）※現在はクライアント側マスクのみ
- オフライン打刻キュー（保存失敗分を localStorage に退避し再送）
- 乗務日報（/nippo、一度実装後に削除済み。復元する場合は attendance と紐づけて再設計）
- 給与明細PDF・年次集計

---

## 7. ユーザー（会社側）が行う手作業 ※実装セッションはまずこれを依頼する

1. https://supabase.com で無料アカウント作成（GitHubログイン可）→ New Project（リージョン **Northeast Asia (Tokyo)**、DBパスワードは控える）
2. SQL Editor で第4章のSQLを全文実行
3. Authentication → Users → 「Add user」で2ユーザー作成（メール確認は自動でconfirmedになる「Create user」ボタンを使用）:
   - `kiosk@fujitaxi.local` ＋ 任意の強いパスワード（端末設定時に1回入力）
   - `admin@fujitaxi.local`（または fujitaxi8810@gmail.com）＋ 管理者パスワード
4. admin ユーザーに管理者ロールを付与: SQL Editor で
   ```sql
   update auth.users
     set raw_app_meta_data = raw_app_meta_data || '{"role":"admin"}'
     where email = 'admin@fujitaxi.local';
   ```
5. Project Settings → API から `Project URL` と `anon public key` をコピーし、実装セッションへ渡す（Vercel の環境変数にも登録: Settings → Environment Variables → `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` → Redeploy）

---

## 8. 検証チェックリスト（ゴールデン値。実装後に必ず全件一致を確認）

現行実装で実測済みの値。休憩・時刻は打刻データを直接seedして検証してよい。

| ケース | 入力 | 期待値 |
|---|---|---|
| 正社員・普通番＋電話番 | 実働9:00（8:00-18:00 休憩60分）, phoneDuty=true, sales=30000(税抜), cardFee=930, 交通費0 | 基本給8,700 / 歩合4,817 / 合計13,517 / 時給換算1,502 |
| 税込→税抜変換 | salesGross=30000 | sales=27273（round(30000/1.1)） |
| 正社員＋交通費 | 上記＋commute3000 | 歩合・手当7,817 / 合計16,517 |
| 時給制 | 時給1200, 8:00-17:30 休憩60分（実働8.5h）, 交通費1000 | 基本10,200 / 残業150 / 深夜0 / 合計11,350 / 時給換算1,335 |
| 時給制・深夜 | 時給1200, 9:00-23:30 休憩60分（実働13.5h）, 交通費1000 | 基本16,200 / 残業1,650 / 深夜450 / 合計19,300 |
| パート | 時給1050, 8:00-17:00 休憩60分, 交通費3000 | 基本8,400 / 手当3,000 / 合計11,400 / 時給換算1,425 |
| 月給制 | 月給300000, 2日出勤, 交通費500/日 | 月次サマリー基本給300,000 / 手当1,000 / 総支給301,000。日別は基本給0円・時給換算「—」 |
| 基本給のみ・固定日給 | 菊地勝治, **遅番**で 15:00-23:00 休憩30分 | 基本給8,000（遅番でも8000。9,100にならないこと）/ 歩合0 / 売上ボタン非表示 |
| UI: 電話番/遅番非表示 | 小林清美・渋佐繁男・菊地勝治・小林結 | ①電話番ブロック非表示・遅番ボタン非表示（普通番のみ1列） |
| UI: 単一出勤ボタン | 佐藤賀子・須江浩子・佐藤文枝・中橋常郎・小林聖人 | シフト選択なし「出勤」ボタンのみ、選択中ラベルは（正社員）or（パート） |
| 管理者ゲート | kiosk状態 | 金額••••マスク、履歴/サマリー/設定/✎×非表示。adminログインで表示、ロックで戻る |
| 多端末同期 | 端末Aで出勤→端末Bでリロード | 端末Bの「本日の状況」に反映される |
| Excel出力 | 上記データで給与計算Excel出力→Excelで開き再計算 | 全体集計の総支給額がアプリの月次サマリーと一致 |

加えて: 打刻の二重送信防止（連打）、通信断時のalert、CSV列順の不変、を確認。

---

## 9. 実装セッションへの指示まとめ

1. ユーザーに第7章を依頼し、URL/anon key を受領
2. 5.1〜5.3 を実装（データ層分離 → kintai.astro差し替え → 旧コード削除）
3. ローカル（`npm run dev`）で第8章を全件検証。Supabaseは本番プロジェクトを直接使ってよい（打刻履歴はゼロスタートのため）。検証で作ったテストレコードは最後に削除すること
4. `npm run build` 成功確認 → コミット（Co-Authored-By: 実装モデル名）→ push → Vercel環境変数設定済みであることを確認してから本番動作確認
5. 移行完了後、ユーザーへ「各端末で一度だけ kiosk ログインが必要」な旨を案内する
