-- 「よけろ！タクシー」全員共通ランキング用のテーブル
--
-- 実行方法：Supabaseダッシュボード → 左メニュー SQL Editor →
--           New query にこの内容を貼り付けて Run
--
-- kintai/haishaと同じSupabaseプロジェクトに、このテーブルを1つ追加するだけ。
-- 既存のテーブル・ポリシーには一切触れない。

-- nicknameのURL/メール禁止は、サイト側（normalizeNickname、game-scores.ts）で
-- 入れている脅迫語・スパムフィルターの簡易版（DB側にJS相当の正規表現は持たせられないため）。
-- クライアントを経由せずAPIへ直接投稿された場合の最低限の歯止めとして置いている。
-- 言葉づかいそのものの最終チェックはSupabaseダッシュボードからの手動削除に頼る。
create table if not exists public.game_scores (
  id uuid primary key default gen_random_uuid(),
  game text not null default 'dodge',
  car text not null check (car in ('nv200', 'jpn', 'hansom')),
  nickname text not null check (
    char_length(nickname) between 1 and 12
    and nickname !~* '(https?://|www\.|@|\.(com|jp|net|co|org|io))'
  ),
  fare integer not null check (fare >= 0 and fare <= 2000000),
  created_at timestamptz not null default now()
);

comment on table public.game_scores is 'ゲーム「よけろ！タクシー」の共通ランキング。お客様が匿名で投稿する（本人確認なし）';

-- 車種×スコアで検索するので、順位表示を速くするための索引
create index if not exists game_scores_car_fare_idx
  on public.game_scores (game, car, fare desc);

-- ランキングは月替わり（今月分のみ表示）なので、created_atでの絞り込みも速くする索引
create index if not exists game_scores_car_created_idx
  on public.game_scores (game, car, created_at);

alter table public.game_scores enable row level security;

-- 誰でも（ログイン不要で）ランキングを見られる
drop policy if exists "誰でもランキングを見られる" on public.game_scores;
create policy "誰でもランキングを見られる"
  on public.game_scores for select
  to anon, authenticated
  using (true);

-- 誰でも（ログイン不要で）スコアを投稿できる
drop policy if exists "誰でもスコアを投稿できる" on public.game_scores;
create policy "誰でもスコアを投稿できる"
  on public.game_scores for insert
  to anon, authenticated
  with check (true);

-- 更新・削除はクライアントから一切許可しない（管理はダッシュボードから手動で行う）
