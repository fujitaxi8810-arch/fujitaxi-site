# 配車管理 `/haisha` Supabase 仕様書

**作成日:** 2026-08-05
**対象:** `src/pages/haisha.astro` / `src/lib/haisha-db.ts`

勤怠 `/kintai`・シフト `/shift` と**同じ Supabase プロジェクト**に配車予約テーブルを1つ追加する。
認証（kiosk / admin）と `staff` マスタは既存のものをそのまま使う。

---

## 1. 背景

配車予約は **電脳交通のクラウド型配車システム「DS」** で受けている。
DSから書き出したCSVをGoogleスプレッドシートに貼り付け、手作業で曜日別の「配車確認シート」に整形し、担当者を割り当てている。

CSVの実データ（2026/08/06分・22件）から分かったこと:

- CSVには**担当者カラムが無い**。担当者の割り当ては人間が別シートでやっている ← ここがアプリ化の主目的
- **降車場所名・降車住所は全行空欄**。行き先は「オペレーター用メモ」に日本語の自由文で入っている
- 事業所名は「富士タクシー(福島)」1種類、登録オペレーターも1種類

### 将来のAPI連携

電脳交通には「**DSコネクト**」という外部サービス接続システムがあり、国交省実証で配車アプリ↔DSの標準API実績もある。
ただし公開APIドキュメントは無く、契約・個別開発が前提。

そのため取り込み処理は **`importReservations(rows: NormalizedRow[])`** という
「正規化済みの行を渡す」形にしてあり、APIが使えるようになったら**入口のパーサだけ差し替えれば済む**。

---

## 2. テーブル定義

Supabase ダッシュボード → SQL Editor で以下を実行する。

```sql
-- ════════════════════════════════════════════
-- 配車予約テーブル
-- ════════════════════════════════════════════
create table dispatch_reservations (
  id uuid primary key default gen_random_uuid(),

  -- ── DSのCSV由来（スプレッドシート「配車確認表」の列に対応） ──
  reserved_at      timestamptz not null,   -- 予約日時
  reserved_date    date not null,          -- 予約日（JST。トリガーで自動設定）
  alarm_minutes    int,                    -- アラーム(分前)  例: 15 / 20 / 30
  office_name      text,                   -- 事業所名
  customer_name    text not null,          -- お客様名
  customer_kana    text,                   -- 読み
  phone            text,                   -- 電話番号
  reservation_memo text,                   -- 予約メモ
  operator_memo    text,                   -- オペレーター用メモ（行き先が入る）
  pickup_name      text,                   -- 場所名（迎車）
  pickup_memo      text,                   -- 場所メモ
  pickup_address   text,                   -- 住所
  dropoff_name     text,                   -- 降車場所名（実運用では空）
  dropoff_address  text,                   -- 降車住所（実運用では空）
  registered_at    timestamptz,            -- 登録日時
  registered_by    text,                   -- 登録オペレーター

  -- ── アプリ側で付与（CSV再取り込みで消えてはいけない） ──
  staff_id   uuid references staff(id) on delete set null,  -- 担当者（勤怠のスタッフ）
  checked    boolean not null default false,                -- 配車確認シートのチェックリスト相当
  app_memo   text,                                          -- アプリ側の申し送り
  status     text not null default 'normal'                 -- 通常／変更あり／キャンセル（人が手で設定）
             check (status in ('normal','changed','cancelled')),
  source     text not null default 'csv' check (source in ('csv','manual')),
  sort_order int,                                           -- 同時刻内の並び調整用

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index dispatch_reservations_date_idx  on dispatch_reservations (reserved_date, reserved_at);
create index dispatch_reservations_staff_idx on dispatch_reservations (staff_id);

-- 再取り込み時の重複防止（安全網）。
-- 同一時刻・同一電話番号・同一登録日時のCSV行は同じ予約とみなす。
-- phone/registered_at が null の行同士は衝突しないよう coalesce で寄せる。
-- ⚠️ 2026-08-17に (reserved_at, phone) だけのキーが原因のデータ消失事故が発覚し、
--    registered_at を追加する形に変更した。詳細は §5.9 を参照。
create unique index dispatch_reservations_csv_key
  on dispatch_reservations (
    reserved_at,
    coalesce(phone, ''),
    coalesce(registered_at, 'epoch'::timestamptz)
  )
  where source = 'csv';
```

### reserved_date を JST で自動設定するトリガー

`reserved_at` は `timestamptz`。日別の絞り込みは日本時間で行いたいので、
JSTの日付を `reserved_date` に落としておく。

> `timestamptz AT TIME ZONE 'literal'` は Postgres では STABLE 扱いのため
> 生成列（generated column）には使えない。トリガーで設定する。

```sql
create or replace function set_reserved_date() returns trigger as $$
begin
  new.reserved_date := (new.reserved_at at time zone 'Asia/Tokyo')::date;
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

create trigger dispatch_reservations_set_date
  before insert or update on dispatch_reservations
  for each row execute function set_reserved_date();
```

---

## 3. RLS

`/kintai` と同じ方針。`is_admin()` は勤怠の移行時に作成済みのものを再利用する。

```sql
alter table dispatch_reservations enable row level security;

-- 参照：認証済みなら全員（ドライバーが自分の担当を見られるように）
create policy dispatch_select on dispatch_reservations
  for select to authenticated using (true);

-- 追加・更新：kiosk も可（事務所端末は kiosk ログインで運用しているため）
create policy dispatch_insert on dispatch_reservations
  for insert to authenticated with check (true);

create policy dispatch_update on dispatch_reservations
  for update to authenticated using (true) with check (true);

-- 削除：管理者のみ
create policy dispatch_delete on dispatch_reservations
  for delete to authenticated using (is_admin());
```

`is_admin()` が未作成の場合（新規プロジェクト等）は以下も実行する。

```sql
create or replace function is_admin() returns boolean as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$ language sql stable;
```

---

## 4. 取り込みのセマンティクス（重要）

CSVを**取り込み直しても、アプリ側で入れた情報は上書きしない**。

| 種別 | カラム | 再取り込み時 |
|---|---|---|
| DS由来 | `reserved_at` `alarm_minutes` `office_name` `customer_name` `customer_kana` `phone` `reservation_memo` `operator_memo` `pickup_*` `dropoff_*` `registered_at` `registered_by` | **更新する** |
| アプリ側 | `staff_id` `checked` `app_memo` `status` `sort_order` | **触らない** |

担当者を割り当てた後に修正版CSVを入れ直しても、割り当てが消えないようにするため。

### DS側の変更・キャンセルの扱い（決定済み）

`status` は**人が手で設定する**。取り込み処理は自動判定しない。

| DS側で起きたこと | 取り込み結果 | 人がやること |
|---|---|---|
| 予約が増えた | 新規行として追加される | 担当者を割り当てる |
| 予約時間が変わった | **別の予約として追加される**（照合キーが変わるため） | 古い方の行に **`changed`（変更あり）** を付ける |
| 予約が取り消された | CSVから消えるだけで、行は残り続ける | その行に **`cancelled`（キャンセル）** を付ける |

自動で削除・統合しない理由は、誤ったCSVを1回貼っただけで大量の行が消える／書き換わる事故を避けるため。
`cancelled` の行は配車ボードで灰色＋取り消し線になり、「要対応」「未割当」の件数から除外される。

**照合キー**: `(reserved_at, phone)`。両方が一致する既存行を「同じ予約」とみなす。

実装は `upsert(onConflict:...)` を使わず、**取り込み対象の日付範囲の既存行を先に取得し、
JS側で新規／更新に振り分けてから insert と update を別々に発行する**。
（部分ユニークインデックスは `onConflict` の列指定と噛み合わないため、また
アプリ側カラムを確実に守るため。）

---

## 5. ユーザーが行う手作業

1. Supabase ダッシュボード → **SQL Editor** で本書 §2 と §3 のSQLを実行する
   （`/kintai` と同じプロジェクトを使う。新しいプロジェクトは作らない）
2. 環境変数は既存の `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY` をそのまま使うため、**追加設定は不要**
3. ログインも既存の `kiosk@fujitaxi.local` / `admin@fujitaxi.local` をそのまま使うため、**アカウント追加は不要**

### 動作確認用のCSV

DSからの書き出しCSV、またはスプレッドシート「配車確認表」を
`ファイル > ダウンロード > カンマ区切り形式(.csv)` で保存したものを1つ用意する。

### ⚠️ 別途対応が必要な件

現在、元になっているGoogleスプレッドシートは**認証なしでCSVを取得できる共有設定**になっている。
氏名・電話番号・住所が含まれるため、共有設定を「**制限付き**」に変更することを強く推奨する。

---

## 5.4 配車に関わらない人（staff.haisha_assignable）

配車に出したくない人は `staff.haisha_assignable = false` にする。これ1つで**2箇所**を制御する:

- **担当者セレクト**の候補
- **乗務割**の表示（`/shift` にシフトが入っていても出さない。事務職などが並ぶのを防ぐ）

なお**日次割り当て（スクール原町・交流・貸切の追加分）は外しても表示し続ける**。
明示的に割り当てた記録なので、消すのではなく×で外せる状態にしておく。

**画面（`staffAdminPanel`）は `<details>` で折りたためる**（既定は開いた状態。
管理者ロック解除で `hidden` が外れると同時に見える）。乗務割・変更履歴と同じ
`.ha-details` / `.ha-details__summary` / `.ha-details__body` の共通パターンを使っており、
`hidden`（管理者権限による表示可否）と `open`（折りたたみの開閉）は独立して効く
― `hidden` が付いている間は `open` に関わらず非表示のまま。

```sql
alter table staff add column haisha_assignable boolean not null default true;
```

**コードに氏名を直接書かないこと。** 過去に氏名の異体字・表記ゆれで不具合が多発しているため、
誰を外すかは必ずDBで管理する。列が無い環境では `true` 扱いにフォールバックする
（`kintai-db.ts` の `rowToStaff`）。

なお**既に割り当て済みの人は、対象外になっていても選択肢に残す**。
そうしないとその予約のセレクトが空欄になり、保存し直した拍子に割り当てが消えるため。

---

## 5.45 引き継ぎと「新着」表示

事務所の営業終了後、配車担当者が交代する（2026-08時点で19時。以前は18時）。
交代後に入った予約を「新着」バッジで示す。

**基準時刻は「手動の記録」と「19時の自動判定」の新しい方**（`newBaselineTime`）。

- **手動**：「引き継ぎ・申し送りを記録」ボタンを押した時刻。実際の交代が定刻とずれても正確
- **自動**：押し忘れ防止。19時を過ぎれば、押さなくても新着が付く

新しい方を採るのは、両方を成立させるため。手動を常に優先すると押し忘れに対応できず、
自動を常に優先すると「20時に実際に交代して押した」操作が無視されてしまう。

### 自動判定の「窓」が肝（過去の不具合の再発防止）

自動判定は **19時から14時間（＝翌9時まで）の夜勤帯にだけ効かせる**
（`AUTO_HANDOVER_HOUR` / `AUTO_HANDOVER_WINDOW_HOURS`）。

かつて窓を設けず「直近に過ぎた固定時刻」を無条件に基準にしていたところ、
**昼14時に画面を見ると基準が前日19時になり、その日の朝に入った予約まで新着扱い**に
なる不具合が発生した（ユーザー指摘で発覚し、一度は自動判定ごと撤去した経緯がある）。

窓があると昼間は自動基準が外れるため、この誤検知が起きない:

| 現在時刻 | 自動基準 |
|---|---|
| 19:00 | 当日19時 |
| 深夜2時 | 前日19時（夜勤中） |
| 朝9:00 | 前日19時（窓の端） |
| 朝9:01〜18:59 | **なし**（昼間は自動基準を使わない） |

昼間でも手で押せばその時刻が基準になる（自動が無くても手動は常に有効）。

```sql
create table dispatch_handovers (
  id uuid primary key default gen_random_uuid(),
  handed_over_at timestamptz not null default now(),
  handed_over_by text,   -- 引き継いだ人（任意）
  note text              -- 申し送り（任意）
);

create index dispatch_handovers_at_idx on dispatch_handovers (handed_over_at desc);

alter table dispatch_handovers enable row level security;

create policy dispatch_handovers_select on dispatch_handovers
  for select to authenticated using (true);
create policy dispatch_handovers_insert on dispatch_handovers
  for insert to authenticated with check (true);
-- 申し送りだけの書き換えを許す（後述）
create policy dispatch_handovers_update on dispatch_handovers
  for update to authenticated using (true) with check (true);
-- 誤操作の取り消し（1つ前に戻す）を事務所でも行えるようにする
create policy dispatch_handovers_delete on dispatch_handovers
  for delete to authenticated using (true);
```

- 判定に使う時刻は `registered_at`（DSでの登録日時）。手入力の予約は `created_at` で代用
- **手動の記録も無く、自動判定の窓の外（昼間）なら、何も新着にしない**
- 記録は履歴として残るので、**最新1件を消せば直前の引き継ぎに戻せる**（`deleteHandover`）
- 押すと全端末に反映される。引き継ぎの性質上これが正しいので、確認モーダルを挟む

**申し送りは引き継ぎと分けて編集できる**（`updateHandoverNote`）。
引き継ぎを記録し直すと `handed_over_at` が今になり「新着」が消えてしまうため、
申し送りの追記だけをしたい場合は `note` のみを更新する。

- 引き継ぎ記録がまだ無い状態で申し送りを書いた場合は、`handed_over_at` に**その時点**を入れる。
  過去の時刻を入れると、申し送りを書いただけで既存の予約に新着が一斉に付いてしまう
### 新着の見せ方 ―「状態」欄にまとめる

新着は**独立したバッジを持たず、「状態」欄に統合**して表示する
（以前は時刻の隣に別バッジを出していたが、1つの予約の扱いが2箇所に分かれて
分かりにくく、65型では列も増えるため）。

- 状態が `normal` かつ新着 → 状態欄の表記を **「新着」**（青緑）にする。
  **DBの値は `normal` のまま**。新着はあくまで導出値で、列としては持たない
- 状態を「変更あり」「キャンセル」にすると、状態欄からは「新着」の文字が消える
  （1つの欄なので当然）。それでも新着だと分かるよう、`ha-status-newmark`
  （青緑の丸に「新」の小さな印）を状態バッジ／セレクトの隣に添える
  （`buildNewMark`。ユーザー提案で追加）
- 行左端の青緑の縦線（`.ha-row--new`）は状態に関わらず常に残る
- 新着を人が消す操作は無い。次の引き継ぎを記録すれば自動的に外れる

### CSV再取り込み時の「変更あり」「キャンセル」自動検出

ユーザー要望：「予定時刻が変わった際は状態を『変更あり』に、キャンセルになった場合は削除せず
状態を『キャンセル』として残したい」。

`buildImportPlan` が、今回のCSVでは説明しきれない既存予約（`MissingReservation`）を検出する:

- 対象は **CSV由来（`source='csv'`）かつ `status='normal'`**（まだ人が手を付けていない）予約のうち、
  今回のCSVの「予約日時＋電話番号」キーのどれとも一致しなかったもの
- 「変更あり」候補として紐付けるのは、**電話番号とお客様名の両方が一致する**、
  まだ使われていない「新規追加」行が今回のCSVにある場合のみ。無ければ**「キャンセル」候補**
  （当初は電話番号だけで判定していたが、施設の代表番号を複数のお客様が共有しているケースで
  無関係な別人の予約同士を誤って結び付ける懸念をユーザーから指摘され、名前の一致も必須条件に追加した。
  電話番号は一致するが名前が違う場合は紐付けを諦め、キャンセル扱いになる＝取りこぼしになるが、
  誤って他人の予約を「変更あり」にするより安全な方に倒している）
- 電話番号・名前の両方が一致する候補が複数ある場合（同じ人が同日に複数件予約している等）は、
  さらに判断材料を追加して絞り込む（ユーザーから「判断材料は多いほど安心」との要望）：
  1. **行き先メモ**（オペレーター用メモ＋場所メモ）が一致するものを優先
  2. それでも決め手が無ければ、**予約時刻が最も近いもの**を選ぶ
- 一度候補として使われた新規追加行は、他の消えた予約からは再利用しない（1対1のマッチング。
  同じ電話番号・名前で複数件が同時に消えても、新規行の数だけしか「変更あり」にならず、
  余りは「キャンセル」扱いになる）
- **電話番号が空同士は絶対にマッチさせない**（`null`同士の誤結合を防ぐ）
- **既に `changed` / `cancelled` の予約、`source='manual'` の予約は対象外**
  （二重処理の防止、手入力データはCSV管理の範囲外という扱い）

適用（`applyImportPlan`）は、`status` 列だけを更新する。**予約行そのものは削除しない**
（ユーザー要望通り、データとして残す）。新規・更新と同じトランザクション内で、
取り込みプレビュー画面に「変更ありに設定：◯件」「キャンセルに設定：◯件」と
対象者の一覧（`<details>`で折りたたみ）を表示し、確認してから確定する。

これは自動判定ではあるが確定前に必ず人の目を通す設計にしている。電話番号・名前・行き先メモ・
時刻の近さと、複数の材料を組み合わせて誤結合を防いだ上で、それでも最終判断は
プレビュー画面で対象者を見てから人が行う。

### 電話番号は一覧に出さない

配車ボード・予約一覧のどちらも、表の列に電話番号は出さない。共有のタッチ画面で
番号がそのまま並ぶのを避けるため。**編集モーダルには残っており**、行をクリック/
タップして開けば見える。検索（`renderList` のフリーワード検索）は列の表示と
独立しているので、電話番号での検索は列を消しても引き続き使える。

### 「行き先・メモ」列は operatorMemo と pickupMemo の両方を見る

当初「行き先・メモ」列は `operatorMemo`（オペレーター用メモ）だけを表示していたが、
**実際にDSから書き出したCSV（`reserve (3).csv`、16件）で検証したところ全件空**だった。
目的地情報は代わりに `pickupMemo`（場所メモ）側に入っていた
（「8/7 15:30予約 ◯◯行(モーター使用)」のように、予約時刻＋行き先＋備考がまとまっている）。

運用や時期によってDS側がどちらの列に書き出すか一定しないと見て、**`destinationText(r)`**
（`operatorMemo` と `pickupMemo` を `／` で連結。片方だけならそれをそのまま表示）に統一した:

- 配車ボード・予約一覧の「行き先・メモ」列
- 予約一覧のフリーワード検索の対象（`pickupMemo` を追加）

修正後、同じ実データで16件中16件が埋まることを確認済み（以前は0/16）。
編集モーダルの「場所メモ」「オペレーター用メモ」は従来通り別々の入力欄のまま
（表示だけを統合し、データの持ち方は変えていない）。

## 5.46 経過した予約の自動非表示

配車ボードでは、**予約時刻から1時間たった予約を自動で隠す**（`haisha.astro` の `HIDE_AFTER_MINUTES`）。
終わった予約が積み上がって、これから対応する予約が埋もれるのを防ぐため。

注意点:

- **今日を表示しているときだけ適用する。** 過去の日を開くと全件が「1時間経過」に当たるため、
  そのまま適用すると画面が空になってしまう
- **「経過分も表示」で戻せる。** 隠したきり確認できないと、済んだ予約を見返せなくなる
- 隠す対象があるときだけボタンを出し、件数を集計行に出す（`時間経過で非表示 N件`）
- 1分ごとに、隠れる件数が変わったときだけ描き直す。毎分描き直すと、
  開いている担当者セレクトが閉じてしまう
- **予約一覧タブには適用しない。** 過去の予約を検索する画面なので、消してはいけない

## 5.47 変更履歴と巻き戻し

予約の追加・変更・削除を**DBトリガーで自動記録**する。アプリ側で記録すると、
経路（取り込み・編集・担当者割り当て）ごとに書き漏らすため。クライアントからは**読み取りと復元のみ**。

```sql
create table dispatch_history (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null,
  action text not null check (action in ('insert','update','delete')),
  old_row jsonb,
  new_row jsonb,
  changed_by text,
  changed_at timestamptz not null default now()
);

create index dispatch_history_at_idx  on dispatch_history (changed_at desc);
create index dispatch_history_res_idx on dispatch_history (reservation_id);

create or replace function log_dispatch_change() returns trigger as $$
declare
  actor text := coalesce(auth.jwt() ->> 'email', 'unknown');
begin
  if (TG_OP = 'INSERT') then
    insert into dispatch_history(reservation_id, action, new_row, changed_by)
      values (new.id, 'insert', to_jsonb(new), actor);
    return new;
  elsif (TG_OP = 'UPDATE') then
    -- 中身が変わっていないUPDATEは記録しない。
    -- CSVを取り込むと全行がUPDATEされるため、これが無いと毎回100件の履歴で埋まる。
    if (to_jsonb(old) - 'updated_at') = (to_jsonb(new) - 'updated_at') then
      return new;
    end if;
    insert into dispatch_history(reservation_id, action, old_row, new_row, changed_by)
      values (new.id, 'update', to_jsonb(old), to_jsonb(new), actor);
    return new;
  else
    insert into dispatch_history(reservation_id, action, old_row, changed_by)
      values (old.id, 'delete', to_jsonb(old), actor);
    return old;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

create trigger dispatch_reservations_history
  after insert or update or delete on dispatch_reservations
  for each row execute function log_dispatch_change();

alter table dispatch_history enable row level security;

-- 参照のみ許可。書き込みポリシーを作らないことで、履歴の改ざんを防ぐ
-- （トリガーは security definer なので所有者権限で書き込める）
create policy dispatch_history_select on dispatch_history
  for select to authenticated using (true);
```

**巻き戻しの挙動**（`revertHistoryEntry`）:

| 履歴の種別 | 元に戻すと |
|---|---|
| `update` | その予約を変更前の値に戻す |
| `insert` | その予約を削除する |
| `delete` | 消された予約を**同じidで復元**する |

- 戻す操作自体も履歴に残る（トリガーが拾うため）
- `id` `created_at` `reserved_date` は復元対象外（`reserved_date` はトリガーが再計算）
- 削除の復元時、CSV取り込みで同じ予約が作り直されていると
  部分ユニークインデックスに弾かれる（`23505`）。その旨を画面に出す

## 5.48 曜日計算のタイムゾーンバグ（修正済み）

`weekdayOf(dateKey)` はかつて
`new Date(dateKey+'T00:00:00+09:00').getUTCDay()` としており、
**曜日が1日ずれるバグ**があった（2026-08-06[木]が「水」と表示される）。

原因: `dateKey+'T00:00:00+09:00'` は「JST午前0時」を表す文字列だが、
`Date` オブジェクトの内部表現は常にUTC。JST 00:00 は UTC 前日15:00なので、
そこに `.getUTCDay()`（UTC基準の曜日）を呼ぶと前日の曜日が返ってしまう。

修正は `dateKey` の年月日を直接 `Date.UTC(y, m-1, d)` で組み立てて
`.getUTCDay()` を取る形。実行環境やブラウザのタイムゾーン設定に関係なく、
常に `dateKey` そのものの曜日になる。`shiftDate`（日付の加減算）は
一貫してUTCタイムスタンプとして扱っているため、このバグの対象外。

## 5.49 CSV取り込みの記録（「このデータは最新版か」の確認）

ユーザー要望：「CSVを貼り付けた日時を確認したい。最新版かどうか判断するため」。

予約行の `updated_at` だけを基準にすると、手動編集（担当者割り当てや状態変更）でも
更新されてしまい、「いつCSVを取り込んだか」の判断材料にならない。そこで**取り込みイベント
そのものを別テーブルに記録**する。

```sql
create table dispatch_imports (
  id uuid primary key default gen_random_uuid(),
  imported_at timestamptz not null default now(),
  imported_by text,           -- ログイン中のメールアドレス（kiosk@fujitaxi.local 等）
  inserted_count int not null,
  updated_count int not null,
  date_from date,             -- 取り込んだ予約の対象期間
  date_to date
);

create index dispatch_imports_at_idx on dispatch_imports (imported_at desc);

alter table dispatch_imports enable row level security;

create policy dispatch_imports_select on dispatch_imports
  for select to authenticated using (true);
create policy dispatch_imports_insert on dispatch_imports
  for insert to authenticated with check (true);
```

- `applyImportPlan` の末尾で `recordImportLog` を呼んで自動記録する
  （`importReservations` 経由の呼び出し＝将来のAPI連携でも自動的に記録される）
- **記録自体が失敗しても、取り込み本体は失敗扱いにしない**（`try/catch` で握りつぶし、
  コンソールにだけ出す）。ログはあくまで付随情報であり、これが原因で本来の取り込みが
  失敗して見えるのは本末転倒なため
- 表示は「予約一覧」タブの上部と、CSV取り込みモーダルの両方
  （`最終取込：8/8 14:32（admin@fujitaxi.local）　新規12件・更新5件`）。
  ページ読み込み時・取り込みモーダルを開いたとき・取り込み成功後に更新する

## 5.491 過去履歴（削除された予約の確認・復元）

ユーザー要望：「削除した予約もデータ上で残るようにしたい。あいうえお順でも見たい。確認できる
ボタンがほしい」。

削除自体は `dispatch_reservations` から行が無くなるが、`dispatch_history`（§5.47）に
`action='delete'` として `old_row` のスナップショットがDBトリガーで自動的に残っている。
これを取り出して一覧表示するのが「過去履歴」ボタン（`fetchDeletedReservations`）。

- 並び順は**お客様名の読み（`customer_kana`）優先、無ければお客様名**で
  `localeCompare(x, 'ja')`。読み仮名が入っているデータは正しく五十音順になるが、
  読み仮名が空のデータは（ひらがなとの比較で）末尾寄りになる。今のところ
  明示的な分離はしていない
- **確認専用**。復元ボタンは無い（ユーザー要望：「復元しなくて大丈夫。確認するだけ」）。
  データそのものを復元したい場合は、ページ最下部の「変更履歴」パネルから
  `revertHistoryEntry` で行える（同じ `dispatch_history` の delete レコードを使うが、
  そちらは管理者操作としての「元に戻す」、こちらは一覧確認、と役割を分けている）
- `restoreDeletedReservation`（`haisha-db.ts`）は実装として残しているが、
  現在どのUIからも呼んでいない。復元操作をこちらの画面にも戻したくなった場合に使う

## 5.5 乗務割（shifts テーブルの参照）

配車ボードの上に「乗務割」を表示する。**`shifts` テーブルを読むだけ**で、書き込みはしない
（シフトの正は `/shift` ページ。二重管理を避けるため）。

表示の作り:

- 予約に担当者を割り当てながら参照するものなので、**スクロールしても画面に残す**
  （`position: sticky`）。貼り付く位置はサイトヘッダーの**実測高**をJSで
  `--ha-sticky-top` に入れて決める。ヘッダー高は画面幅で変わるため決め打ちにしない
- 邪魔なときのために `<details>` で**畳める**。開閉状態は localStorage に持たせ、
  閉じた人が毎回開き直さずに済むようにする

**CSSの落とし穴**: `.ha-duty-name` などの個別スタイルは、`.ha-badge` /`.ha-select` より
**前**に定義されている。同じ詳細度だと後勝ちで潰されるため、
`.ha-badge.ha-duty-name` のようにクラス2つ分の詳細度で書くこと。

**貼り付いた（stuck）状態の検知**: `position: sticky` の状態はCSSだけでは取れないため、
直前に高さ0の目印（`#dutyStickySentinel`）を置き、それが画面外に出たかを
`IntersectionObserver` で監視して `.is-stuck` クラスを付け外しする
（`entry.isIntersecting === false` ＝目印が見えない＝乗務割が本来の位置を離れて固定された）。

貼り付いた間だけ幅を狭くする案は一度試したが、ユーザー判断で不採用になった
（「現状のままでいいので横に広げてほしい」）。今は `.is-stuck` は**枠線の強調**
（貼り付いていることが分かる程度）にだけ使っている。

**貼り付いたら、開いていても自動的に閉じる**（ユーザー指摘：「スクロールした際に
配車ボードが見にくい」への対応）。開いたまま貼り付くと、乗務割
（最大 `min(46vh, 420px)`）がヘッダー下に居座り続け、下にある配車ボードの表示領域を
圧迫する。`IntersectionObserver` のコールバックで、stuckになった瞬間 `panel.open`
なら `false` にする。見出しは残るので、必要ならもう一度クリックして開ける。

**既定は「開いたまま」ではなく「閉じている」**（§前節参照）。初期表示で開いた状態にすると、
ページ最上部ではまだ乗務割は本来の位置（画面上部から離れた場所）にあり `.is-stuck` が付かないため、
他のパネルと同じ幅のまま画面の大半を占めてしまう。

## 5.55 文字サイズの切替

65型のタッチ表示（IB-65UED01B）と手元のPCの両方で使う。適切な文字サイズが大きく違うが、
**視距離は端末側から判別できない**ため、見る人が選ぶ方式にした（標準／大／特大 = 100/130/165%）。

- ルート要素の `font-size` を変えるだけ。CSSが `rem` で書かれているので全体が追従する
- **タッチ領域も `rem` で指定すること**。`min-height: 44px` のままだと文字だけ大きくなり、
  65型で指が当てにくいまま残る。`kt-components.css` と `haisha.astro` の
  `min-height` はすべて `rem` に変換済み
- 選択は localStorage に保存。65型は「特大」、PCは「標準」を一度選べば以降そのまま
- 拡大するとヘッダーの高さも変わるので、`applyZoom` から `syncStickyOffset()` を呼び直す

**特大時はコンテナの横幅も広げる。** 実機（65型）の写真で確認したところ、文字を拡大しても
ヘッダー・見出し・本文はいずれも `--container-max`（`global.css` で `1200px`）に
中央寄せされたままで、大画面では左右に大きな余白が残っていた。

`.ha-wrap` だけを広げても、ヘッダー（`Layout.astro` の `.nav__inner`）や
`.page-hero` の `.container` は既に `max-width: 100%` で画面幅いっぱいだった
ため無意味。ヘッダー・見出し・本文が共通して参照している **`--container-max` 自体を
`applyZoom` から上書き**することで、ページ全体を連動して広げる:

```js
if (pct >= 165) --container-max を min(96vw, 2200px) に
else if (pct >= 130) --container-max を min(92vw, 1600px) に
else removeProperty で既定の 1200px に戻す
```

`.ha-wrap` 自体は元々 `max-width: 100%` なので変更不要（親のコンテナが
広がれば連動して広がる）。標準幅に戻すときは `removeProperty` を使うこと
（固定値で 1200px を再設定すると `global.css` 側の変更に追従できなくなる）。

配車確認シート上部の勤務区分と `/shift` のコードの対応（ユーザー確認済み）:

| 配車確認シートの行 | 出どころ |
|---|---|
| 普通 | `/shift` の `①`（普通番 7:00-16:00） |
| 遅番 | `/shift` の `③`（遅番 15:30-24:30） |
| スクール | **併用**：`/shift` の `S` が基本＋`/haisha` で当日追加 |
| 乗合 | `/shift` の `SH`（シャトル便） |
| **スクール原町** | `/haisha` で日ごとに割り当て（前日に確定） |
| **交流** | `/haisha` で日ごとに割り当て（前日に確定） |
| **貸切** | **併用**：`/shift` の `貸切` が基本＋`/haisha` で当日追加 |

スクール原町・交流は月次シフトでは決まらないため、`dispatch_duties` テーブルに
日付＋区分＋スタッフで持つ（§5.6参照）。

**貸切・スクールは両方を並べる**。基本はシフト通りだが当日変わることがある、というユーザーの運用に合わせた:

- `/shift` 由来の名前 … ×なし（変更は `/shift` 側で行う）
- `/haisha` で足した名前 … ×付きで外せる
- 追加セレクトの候補からは、すでに出ている人（シフト由来を含む）を除外する

なお**シフト由来の人をこの画面から外すことはできない**（除外レコードを持たせていないため）。
当日その人が抜ける運用が出てきた場合は、除外の仕組みを追加する必要がある。

## 5.6 日次の勤務割り当て（dispatch_duties）

月次シフトでは決まらず、前日〜当日に確定する区分を、日付ごとに保存する。編集はこの画面から
「＋追加」／「×」で行い、事務所ロック（管理者ログイン）は不要（毎日の入れ替えを想定するため）。

```sql
create table dispatch_duties (
  id uuid primary key default gen_random_uuid(),
  work_date date not null,
  category text not null check (category in ('school_haramachi','exchange','charter')),
  staff_id uuid not null references staff(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (work_date, category, staff_id)
);

create index dispatch_duties_date_idx on dispatch_duties (work_date);

alter table dispatch_duties enable row level security;

create policy dispatch_duties_select on dispatch_duties
  for select to authenticated using (true);
create policy dispatch_duties_insert on dispatch_duties
  for insert to authenticated with check (true);
create policy dispatch_duties_delete on dispatch_duties
  for delete to authenticated using (true);
```

`category` は当初 `school_haramachi` / `exchange` の2種類だったが、`貸切` を月次シフト
（`/shift` の `貸切` コード）から日次割り当てに変更した際に `charter` を追加した。
その後「スクール」（`/shift` の `S`）も貸切と同じハイブリッド形式にし、`school` を追加した:

```sql
alter table dispatch_duties drop constraint dispatch_duties_category_check;
alter table dispatch_duties add constraint dispatch_duties_category_check
  check (category in ('school_haramachi','exchange','charter','school'));
```

`school` は「スクール原町」の `school_haramachi` とは別物（紛らわしいが、既存の命名を尊重して
そのまま追加した）。「スクール」＝ `/shift` の `S` の当日追加分、「スクール原町」＝月次シフトに
無い区分の日次割り当て、という違い。

---

## 5.7 管理者UIの表示切り替え（`?admin`）

実証実験を前に、権限まわりをユーザーと相談。「管理者と一般スタッフでURLを分けたい」という
要望があったが、**URLはセキュリティの境界ではない**ことを最初に共有した ―― 削除や
「配車に関わる人の設定」は、画面のボタンではなく Supabase 側（`is_admin()` を見るRLS）で
実際に許可・拒否している。URLを分けても分けなくても、パスワードを知らない人には削除操作は
できない。

その上で、「一般スタッフには管理者ロック解除ボタンの存在自体を見せたくない」という
UI/UX上の要望として、以下の形で実装した：

- `/haisha` を開いた一般スタッフには、`.kt-adminbar`（🔒バー・「管理者ロック解除」ボタン）を
  **既定で非表示**にする
- URLに `?admin` を付けた `/haisha?admin` を開いたとき、または既にそのセッションが
  管理者ログイン済みのとき（URLを付け直さなくても「ロックする」で戻せるように）だけ表示する
- ページを新規に分ける（例：`/haisha-admin` を別ファイルとして作る）のは、Astroがページ間で
  コードを共有しないため2600行超のページをほぼ丸ごと複製することになり避けた。
  同じ `/haisha` 1ページのまま、クエリ文字列で表示を切り替えるだけにしている

```ts
// URLに ?admin が付いている、または既に管理者ログイン済みなら管理者バーを見せる
function applyAdminUiVisibility() {
  const wantsAdminUi = new URLSearchParams(location.search).has('admin') || isAdmin();
  $('adminBar').hidden = !wantsAdminUi;
}
```

「配車に関わる人の設定」パネル（`staffAdminPanel`）の表示条件は変更していない
（従来通り `isAdmin()` のみで判定。こちらは元々URLに関係なく実際のログイン状態だけを見ている）。

事務所PC・タッチ画面には `/haisha` を、管理者（削除や担当者候補の設定を行う人）には
`/haisha?admin` をブックマークとして配る運用を想定。

---

## 5.8 社内アプリ専用アイコン・ホーム画面追加

実証を前に「アプリのアイコンみたいなのを作れるか」と要望があり対応。`/haisha`・`/kintai`・`/shift`
それぞれに専用アイコンを用意し、スマホ・タブレットの「ホーム画面に追加」でアプリらしく開けるようにした。

- 共通デザイン：黒の角丸バッジ＋黄色の絵柄（配車＝タクシー、勤怠＝時計、シフト＝カレンダー）、
  下に富士タクシーの丸ロゴを小さく配置（「アイコンにFUJITAXIと分かるように」という要望への対応）。
  時計の絵柄は最初「く」の字の2本線で作ったところ、レビューで「チェックマークに見える」と
  分かったため、12時・3時方向の直角ポーズに描き直した
- 元データは `public/icons/{haisha,kintai,shift}.svg`。512x512で作り、`sharp`で16/32/180/192/512pxの
  PNGに書き出している（`public/icons/{key}-{size}.png`）
- 各アプリに `public/manifest-{key}.json`（Web App Manifest）を用意。`Layout.astro` の新しい
  `appIcon` プロップ（`{ key, name }`）を渡すと、faviconをアプリ専用アイコンに差し替え、
  `<link rel="manifest">` と `apple-mobile-web-app-*` メタタグを追加する
  （iOSでホーム画面に追加した際、ブラウザのアドレスバー無しで開くようになる）
- `appIcon` を渡さないページ（通常の公開サイト）は、これまで通り会社ロゴのfaviconのまま
- **副産物の修正**：調査の過程で、サイト全体のfavicon設定（`/favicon.svg`・`/apple-touch-icon.png`）が
  実体の無いファイルへのリンク切れだと判明（`Layout.astro` に前から書かれていたが、対応する
  ファイルが一度も `public/` に置かれていなかった）。実在する会社ロゴ（`public/images/logo-fuji-taxi.webp`）
  から円形に切り抜いた透過PNG（`public/images/logo-fuji-taxi-round.png`）を作り、
  `public/favicon-{16,32,180,192,512}.png` として書き出して差し替えた
- 管理者用の `/haisha?admin` は同じ `/haisha` ページなのでマニフェストも1つ（`start_url` は `/haisha`）。
  Androidの「アプリをインストール」はマニフェストの `start_url` を使うため、`?admin` 付きでインストールしても
  起動後は付かない。管理者はブラウザの通常のブックマーク（URLをそのまま保持する）を使う想定

---

## 5.9 データ消失事故と修正（同時刻・同電話番号の複数予約が1件に潰れる）

**発覚:** 2026-08-17。ユーザーから「8/17 13:10予約が3件のはずが1件にまとまっている。17:30予約も同じ」と報告。
ユーザー提供のDS書き出しCSV（`reserve (4).csv`）を確認したところ、東北送配電サービス様の
17:30予約が3行あり、**予約日時・電話番号・お客様名・行き先メモなど全項目が完全に同一で、
唯一「登録日時」だけが1分ずつ違う**（13:45→13:46→13:47）ことを確認した
（車1台ずつ、DS側で1分おきに登録されたとみられる＝法人が同時刻に複数台を依頼したケース）。

### 原因

`matchKey(reservedAt, phone)`（`src/lib/haisha-db.ts`）が予約時刻＋電話番号だけで
「同じ予約」を判定していたため、以下の2箇所で正しく別々の予約と扱われなかった：

1. **`buildImportPlan` のファイル内重複排除**（`byKey` Map）。取り込むCSVの中で同じキーの行が
   来ると「後勝ちで1件に寄せる」ため、3行のうち2行がDBに書き込まれる前に静かに消えていた
   （画面上は「重複していた行」件数として一応出るが、これが正常なCSVの重複除去なのか、
   実は別々の正当な予約を握りつぶしているのか区別できない見た目だった）
2. **DB側のユニークインデックス `dispatch_reservations_csv_key`**（`reserved_at, coalesce(phone,'')`）。
   仮に1の重複除去を素通りしても、2件目以降の insert がユニーク制約違反になっていた

### 修正内容

`matchKey` に **登録日時（`registered_at`）** を第三の要素として追加した
（`src/lib/haisha-db.ts` の `matchKey` 関数、および `buildImportPlan` 内の2箇所の呼び出し）。

```ts
function matchKey(reservedAt: string, phone: string | null, registeredAt: string | null): string {
  const registeredKey = registeredAt ? new Date(registeredAt).getTime() : '';
  return `${new Date(reservedAt).getTime()}|${normalizePhoneKey(phone)}|${registeredKey}`;
}
```

DB側のユニークインデックスも `registered_at` を含む形に**再作成が必要**（§2のDDLブロックを更新済み。
既存のSupabaseプロジェクトには反映されていないため、下記SQLを**ユーザーがSQL Editorで実行**する）：

```sql
drop index if exists dispatch_reservations_csv_key;

create unique index dispatch_reservations_csv_key
  on dispatch_reservations (
    reserved_at,
    coalesce(phone, ''),
    coalesce(registered_at, 'epoch'::timestamptz)
  )
  where source = 'csv';
```

### 影響範囲の確認

- **CSV再取り込み時の「変更あり」「キャンセル」自動検出**（§5.45にある `buildImportPlan` の missing 検出ロジック）は
  `matchKey` を直接使っておらず、電話番号・お客様名・行き先メモ・時刻の近さで独自に候補を絞る作りのため、
  今回の変更による影響は無い
- 既存の同一(reserved_at, phone)で登録日時も同じ行（true duplicate、CSVの二重貼り付け等）は
  引き続き正しく1件に統合される
- 失われたうち **17:30の2件は「＋新規予約」で手動復元済み**（`app_memo`に復元した旨を記録）。
  **13:10の2件は実証実験中のため未対応のまま**（ユーザーの判断で保留）

### ⚠️ 追加で発覚した罠：Excelで開いて保存し直すと登録日時の秒が消える

修正後の動作確認中、ユーザー提供の `reserve (4).csv`（DSから直接ダウンロード→**Excelで開いて保存し直した**もの）を
実際にCSV取り込み機能へ通したところ、**もともとDBに入っていた9件（同日 08/17 12:31 に、Excelを介さずDSの
ダウンロードそのままで取り込まれたもの）と1件も一致せず、9件すべてが新規重複として検出される**という
再発が起きた（幸い確認だけしてキャンセルし、実データへは適用していない）。

原因はnullではなく、**登録日時の「秒」の有無によるズレ**だった：

| データ | 例 |
|---|---|
| DB内（DS直接ダウンロードで取り込み済み） | `2026-08-17 09:53:41` |
| `reserve (4).csv`（Excelで開いて保存し直し） | `2026/8/17 9:53`（秒の情報が失われ常に00秒扱い） |

`matchKey` はミリ秒まで含めた厳密一致のため、41秒のズレだけで別予約とみなされてしまう。
**Excelは日時をセルの表示形式に応じて丸めてCSV書き出しするため、秒が失われる**（電話番号の先頭0が
落ちる問題と同根＝Excel/スプレッドシートを経由する時点で数値・日付が再解釈される）。

**運用ルールとして確定**：CSV取り込みは、**DSからダウンロードしたファイルをそのまま使う。Excel等で
開いて保存し直さない**（閲覧のみは問題ない）。これを守れば、同じダウンロード方式同士は登録日時の
精度が揃うため、今後の再取込みでも正しく一致する。

### 取り込み前の警告（2026-08-19 追加）

上記の罠は運用ルール（DSのダウンロードをそのまま使う）で防ぐ前提だが、実証中に誤ったファイルを
取り込むと実データが壊れるため、プレビュー画面に赤枠の警告を2つ追加した（`haisha.astro` の
`importParseBtn` ハンドラ）。警告は件数の行より**上**に出し、見落とし防止に取り込みボタンでも
`confirm()` で念押しする。

| 警告 | 条件 | 防ぎたい事故 |
|---|---|---|
| すでに入っている◯件が「変更あり」「キャンセル」に変わります | `missing >= 3 && missing >= updates` | ファイル違い／一部だけ貼り付け／Excel経由で秒が落ちた |
| 登録日時を読み取れない行が◯件あります | `registeredAt` が null の行が1件以上 | 登録日時が欠けて複数台予約が1件に潰れる（§5.9の再発） |

1つ目の条件は当初「1件も一致しない（`updates === 0`）」にしていたが、実データで検証したところ
**たまたま1件だけ一致して警告が消える**ことが分かった（8件が変更あり・キャンセルになる計画なのに
無警告だった）ため、割合で見る条件に改めた。初めて取り込む期間は `missing` が0件なので誤検知しない。

### 「変更なし」を更新から分離（2026-08-19 追加）

DSのCSVは**毎回すべての予約を書き出す**ため、取り込みのたびに大半の行が「既存と一致した行」になる。
これを一律「更新」として数えていたので、「更新20件」と出ても中身が変わったのか同じものが再度
流れてきただけなのか区別できなかった（ユーザー指摘：「内容が変わっていないものはそのままで、
新着や変更ありが出てくると紛らわしい」）。

`buildImportPlan` で、一致した既存行とDS由来カラムを突き合わせ（`isSameDsContent`）、
**1文字も変わっていなければ `updates` に入れず `unchanged` として数えるだけにした**。
DBへの書き込みも発生しない。プレビューと完了メッセージでは「変更なし：◯件（内容が同じなので
何もしません）」と淡色で別に出し、「内容が変わった予約」は開いて一覧で確かめられるようにした。

実装上の注意（壊しやすい点）：

- **`matchedKeys.add(k)` は内容比較の外側で行う**。内側に入れると、変更なしの予約が
  「今回のCSVから消えた」と誤判定され、まとめてキャンセル扱いになる
- 日時は**必ず時刻値で比較**する。DBは `+00:00`、CSV由来は `...Z` と文字列の形が違っても
  同じ時刻を指すため、文字列比較だと毎回「変わった」と誤判定される
- null と空文字は同じ意味として扱う（DSの空欄がどちらで入るかは取得経路次第）
- 上の取り込み前警告の判定も `updates` ではなく **`updates + unchanged`**（＝一致した既存行の総数）と
  比べる必要がある。この分離によって正常な取り込みほど `updates` が0に近づくため、
  `updates` のままだと数件の正当なキャンセルで誤警告する

### 配車済みの予約がキャンセルと誤表示される問題（2026-08-19 修正）

実証中の初回取り込みで発覚。**DSのCSVは配車が完了した予約を書き出さなくなる**。
そのため「今回のCSVに見当たらない＝DS側で消された＝キャンセル」という判定が、
配車済みの予約まで巻き込んでいた（08/19 の 07:30 寺谷様・08:00 小林様の2件が、
すでに配車完了しているのにキャンセル扱いになった）。

アプリからは「キャンセルされた」のか「配車が終わった」のか区別できないため、時刻で切り分ける。
`CANCEL_DETECT_LEAD_MS`（1時間）を設け、**予約時刻がそれより先のものだけ**を
キャンセル自動判定の対象にした。配車はアラーム（実データで15〜30分前）の頃に行われるため、
1時間あれば配車済みを取り違えない。

代償として、**直前（1時間以内）の本当のキャンセルは自動では拾えなくなる**。これは人が手で
状態を付ける運用でカバーする。ユーザーに3案（時刻で切り分け／自動判定を廃止／「完了」状態を新設）を
提示し、この案が選ばれた。

> 補足：DSのこの挙動は、キャンセル判定だけでなく「予約が消えた」ように見える他の
> 場面すべてに影響する。CSVは**その時点で未配車の予約の一覧**であって、
> その日の全予約の一覧ではない、という前提で読むこと。

### 「変更あり」から新しい予約への矢印（2026-08-19 追加）

ユーザー指摘：「変更ありの際に何が変更になっているのか」「時刻変更の際に変更になった予約が
どれか」が分からない。原因は、`buildImportPlan` の「消えた予約」検出（§5.45）が古い予約に
`status='changed'` を付けるだけで、紐付けた新しい予約とのつながりをDBに一切残していなかったため。
確定した瞬間にその場限りの情報として消えていた。

なお「メモなど内容だけが変わった」場合（時刻は変わらず`updates`として更新される場合）は、
DBトリガーが自動記録する**変更履歴に既に項目単位の差分が残る**ため対応不要。今回対応したのは、
時刻が変わって別の行として扱われる「変更あり」のケースのみ。

```sql
alter table dispatch_reservations
  add column superseded_by uuid references dispatch_reservations(id) on delete set null;
```

- `applyImportPlan`：新規insertを**1件ずつ**発行して確実にidを受け取り（`tempId → 実id`のMap）、
  「変更あり」に紐付けた予約の更新時に `superseded_by` へ実idをセットする。以前はまとめてinsertして
  戻り値を使っていなかったため、この対応でついでに1件ずつに変更した（1日あたり数十件程度なので
  負荷は問題ない。まとめinsertの戻り値の並び順が入力順と一致する保証が無いことへの対処も兼ねる）
- 取得側（`fetchReservationsByDate` / `fetchReservationsRange`）は
  `select('*, superseded:superseded_by(reserved_at)')` で**変更後の予約の日時を一度に埋め込み取得**する。
  表示期間の外に変更後の予約があっても（例：今日の予約が来月に動いた等）表示できるようにするため
- 表示：ボード・一覧どちらも、状態が「変更あり」のとき「→ 17:35に変更」のような文字をクリックできる
  形で添える（`buildSupersededNote`）。押すと配車ボードでその日を開く
- この機能の追加**前**に「変更あり」になった予約（過去分）は `superseded_by` が無いため、矢印は出ない
  （何も出ない＝以前と同じ見た目に留まるだけで、エラーにはならない）
- 2026-08-21実運用（8/21 08:20→09:20 宮本様の実際の時刻変更）で動作確認。SQLで手動リンクを張って確認：
  ```sql
  update dispatch_reservations
  set superseded_by = (
    select id from dispatch_reservations
    where reserved_at = '2026-08-21 09:20:00+09' and phone = '08018348581' and status = 'normal'
  )
  where reserved_at = '2026-08-21 08:20:00+09' and phone = '08018348581' and status = 'changed';
  ```
  ボード・一覧の両方で「→ 09:20に変更」が正しく表示され、クリックで正しい日付のボードへ移動することを確認

### 時刻以外の変更点・逆方向のリンクを追加（2026-08-21）

ユーザーから2点追加要望：①迎車場所・メモも変わっていれば分かるようにしたい、②「変更あり」になった
古い予約だけでなく、**新しい方の予約を見ても元は同じ予約だと分かるようにしたい**。

- `SELECT_WITH_SUPERSEDED` の埋め込みを、日時だけでなくDS由来カラム一式
  （迎車場所・メモ・アラーム等。`staff_id`/`checked`/`app_memo`/`status`はアプリ側の状態で
  新旧で違って当然なので含めない）に拡張。既存の「変更履歴」で使っている `diffFields` /
  `FIELD_LABELS` / `fieldValueLabel` をそのまま流用し、`toDsRawFields()` で
  Reservation（キャメルケース）をDBの生の列名の形に変換して比較する
- **逆方向のリンク**（新しい予約→元の予約）は、自己参照FKの逆embedで実現：
  ```
  supersededFrom:dispatch_reservations!superseded_by(reserved_at)
  ```
  本番のSupabaseに対して実際にクエリを投げ、この書き方で通ることを事前に確認してから実装した
  （`dispatch_reservations!superseded_by` という指定の仕方が、自己参照FKの逆方向embedの正しい書き方）
- 表示は「→ 17:35に変更」の下に、変わった項目があれば箇条書きで続ける
  （例：「場所メモ：8/21 820予約 原ノ町駅迄 → 8/21 9:20予約 原ノ町駅迄」）。
  新しい方の予約には「← 08:20から変更」と逆向きに表示し、押すと元の予約がある日をボードで開く

### 教訓・積み残し

DSのCSV出力には「予約ID」のような一意キーが無く、`reserved_at + phone` は人間には自明でも
システム上は同一予約の保証にならない。`registered_at` は分単位までしか無いため、
理論上は「同時刻・同電話番号・同分に登録された複数の別予約」がまだ衝突しうる
（今回のケースは1分ずつずれていたため助かった）。また上記の通り、**登録日時は取得経路（DS直接／
Excel経由）によって精度が変わりうる**ため、複数の取り込み経路を混在させないことが前提となる、
という新たな制約も判明した。DSコネクトAPI連携が実現すれば本来の予約IDが取れる可能性があり、
その際はこの仮のキーから置き換えるのが望ましい。

---

## 6. 想定していないこと（将来の課題）

- **DSコネクトによるAPI直結**。実現すればCSVの手作業が消える。電脳交通への問い合わせが前提
- **アラーム(分前)の通知**。現状はDS側の機能。アプリでは値を保持・表示するのみで、鳴らさない
- **降車場所の構造化**。DSが降車情報を出していないため、行き先は `operator_memo` の自由文のまま
- **（検討したが対応不要と判断）`registered_at` が「CSV重複防止の照合キー」と「新着判定の基準」を
  兼ねている問題**（2026-08-17発覚）。§5.9の事故対応で、消えていた予約を手動復元した際に「登録日時を
  DSの値のまま保つ（＝重複防止を優先）」か「登録日時を今の時刻にする（＝新着表示を優先）」かが
  両立せず、今回は前者を選んだ（新着表示は諦めた）。解決策として「新着表示専用の別列を追加する」案を
  出したが、ユーザーの意向は「特別扱いは不要。時系列に予約時刻順で並んでいれば十分」とのことで、
  列追加は行わないことに決定。今後も同様の場面では重複防止（登録日時をDSの値のまま保つ）を優先する
