const fs = require("fs");
const DOW = ["日", "月", "火", "水", "木", "金", "土"];
const YEAR = 2026, MONTH = 11; // 11月
// 祝日は src/lib/holidays.ts と同じ
const HOL = { "2026-11-03": "文化の日", "2026-11-23": "勤労感謝の日" };
const dim = new Date(Date.UTC(YEAR, MONTH, 0)).getUTCDate();
const key = (n) => `${YEAR}-${String(MONTH).padStart(2, "0")}-${String(n).padStart(2, "0")}`;

// シフトは関係なく、曜日・祝日で決める
//  D: 日曜日・祝日 … 日勤・遅番とも1人 → 予約受付表（紙）のみ → 翌日の日勤がWチェック
//  B: 月曜日        … 日勤はWチェック可、遅番は1人 → 予約受付表（紙）のみ → 翌日の日勤が朝にWチェック
//  A: それ以外      … 当日で完了
const days = [];
for (let n = 1; n <= dim; n++) {
  const dw = new Date(Date.UTC(YEAR, MONTH - 1, n)).getUTCDay();
  const hol = HOL[key(n)];
  const kind = dw === 0 || hol ? "D" : dw === 1 ? "B" : "A";
  days.push({ n, dw, hol, kind });
}
function nextLabel(x) {
  const nn = x.n + 1;
  const nd = DOW[(x.dw + 1) % 7];
  return nn <= dim ? `${nn}日(${nd})` : `${MONTH + 1}/1(${nd})`;
}
function cell(x) {
  let tag = "";
  if (x.kind === "A") tag = `<span class="tg ok">当日で完了</span>`;
  if (x.kind === "B") tag = `<span class="tg b">→ ${nextLabel(x)}の朝</span>`;
  if (x.kind === "D") tag = `<span class="tg d">→ ${nextLabel(x)}<br>Wチェック</span>`;
  const sub = x.hol ? `<div class="ct hol">${x.hol}</div>` : x.dw === 0 ? `<div class="ct">日曜日</div>` : x.dw === 1 ? `<div class="ct">月曜日</div>` : `<div class="ct">&nbsp;</div>`;
  return `<td class="k-${x.kind}"><div class="dn"><b>${x.n}</b><i>${DOW[x.dw]}</i></div>${sub}${tag}</td>`;
}

const first = days[0].dw;
let cells = [];
for (let i = 0; i < first; i++) cells.push(`<td class="blank"></td>`);
for (const x of days) cells.push(cell(x));
while (cells.length % 7 !== 0) cells.push(`<td class="blank"></td>`);
let rows = "";
for (let r = 0; r < cells.length / 7; r++) rows += `<tr>${cells.slice(r * 7, r * 7 + 7).join("")}</tr>\n`;

const fmt = (arr) => arr.map((x) => x.n + "日").join("・");
const listB = fmt(days.filter((x) => x.kind === "B"));
const listD = fmt(days.filter((x) => x.kind === "D"));

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wチェックができない日の対応</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Zen+Kaku+Gothic+New:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
:root { --ink:#1a1a1a; --muted:#555; --line:#222; --soft:#f1f1f1; --soft2:#e4e4e4; --soft3:#c9c9c9; --font:"Zen Kaku Gothic New","Hiragino Sans","Yu Gothic","Meiryo",sans-serif; }
* { box-sizing: border-box; }
html { background:#e9e8e3; }
body { margin:0; color:var(--ink); font-family:var(--font); line-height:1.4; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.sheet { width:210mm; min-height:297mm; margin:12px auto 40px; background:#fff; padding:5mm 11mm 3mm; box-shadow:0 2px 18px rgba(0,0,0,.18); }
header { border-bottom:3px solid var(--line); padding-bottom:3px; margin-bottom:5px; display:flex; justify-content:space-between; align-items:flex-end; gap:10px; }
.role { display:inline-block; font-size:10pt; font-weight:900; color:#fff; background:var(--line); border-radius:6px; padding:1px 12px; letter-spacing:.08em; margin:0 0 3px; }
h1 { margin:0; font-size:20pt; line-height:1.2; font-weight:900; white-space:nowrap; }
.sub { font-size:11pt; font-weight:700; margin:2px 0 0; }
.when { font-size:8.5pt; color:var(--muted); text-align:right; white-space:nowrap; }
h2.sec { margin:6px 0 3px; font-size:12.5pt; font-weight:900; display:flex; align-items:center; gap:7px; }
h2.sec .n { width:26px; height:26px; border-radius:50%; background:var(--line); color:#fff; display:inline-flex; align-items:center; justify-content:center; font-size:12pt; }

.reason { border:2.5px solid var(--line); border-radius:10px; padding:4px 10px; background:var(--soft); font-size:10pt; font-weight:700; margin-bottom:5px; }
.two { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.dcard { border:2.5px solid var(--line); border-radius:12px; overflow:hidden; background:#fff; }
.dcard .dh { background:var(--line); color:#fff; padding:3px 10px; font-weight:900; font-size:12pt; display:flex; justify-content:space-between; align-items:baseline; }
.dcard .dh small { font-size:8.5pt; font-weight:500; opacity:.9; }
.flow { padding:5px 8px 6px; display:flex; flex-direction:column; gap:3px; }
.step { border:2px solid var(--line); border-radius:8px; padding:3px 8px; display:grid; grid-template-columns:62px 1fr; gap:6px; align-items:center; background:#fff; }
.step .who { font-weight:900; font-size:10pt; line-height:1.2; }
.step .who small { display:block; font-size:8pt; font-weight:500; color:var(--muted); }
.step .what { font-size:9.5pt; line-height:1.35; }
.step .pp { font-size:11pt; letter-spacing:1px; font-weight:900; }
.step.ng { background:var(--soft); border-style:dashed; }
.step.fin { border-width:3px; background:var(--soft2); }
.st { display:inline-block; font-weight:900; font-size:9pt; border-radius:4px; padding:0 6px; margin-right:4px; }
.st.o { border:1.5px solid var(--line); background:#fff; }
.st.x { background:var(--line); color:#fff; }
.dn2 { text-align:center; font-weight:900; font-size:10pt; line-height:1; margin:0; }

table.cal { width:100%; border-collapse:separate; border-spacing:0; border:2px solid var(--line); border-radius:8px; overflow:hidden; table-layout:fixed; }
.cal th { background:var(--soft2); font-size:9.5pt; padding:2px 0; border-bottom:1.5px solid var(--line); }
.cal td { height:19mm; vertical-align:top; padding:1.5px 3px 2px; border-right:1px solid #999; border-bottom:1px solid #999; font-size:8pt; }
.cal td:last-child { border-right:none; }
.cal tr:last-child td { border-bottom:none; }
.cal .blank { background:repeating-linear-gradient(45deg,#fff,#fff 4px,#f3f3f3 4px,#f3f3f3 8px); }
.dn { display:flex; align-items:baseline; gap:3px; }
.dn b { font-size:12pt; line-height:1.1; }
.dn i { font-style:normal; font-size:8pt; color:var(--muted); }
.ct { font-size:7.5pt; color:var(--muted); line-height:1.25; white-space:nowrap; }
.ct.hol { font-weight:900; color:var(--ink); }
.tg { display:block; margin-top:1px; font-size:7.8pt; font-weight:900; line-height:1.25; border-radius:3px; padding:0 3px; }
.tg.ok { color:var(--muted); font-weight:500; }
.tg.b { background:var(--soft3); border:1.2px solid var(--line); }
.tg.d { background:var(--line); color:#fff; }
.k-B { background:#f4f4f4; }
.k-D { background:var(--soft2); box-shadow:inset 0 0 0 2px var(--line); }
.legend { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin:4px 0 0; font-size:8.5pt; }
.legend div { border:1.5px solid var(--line); border-radius:6px; padding:2px 6px; line-height:1.3; }
.legend b { display:block; font-size:9pt; }
.note { margin:4px 0 0; font-size:8.5pt; color:var(--muted); line-height:1.4; }
.foot { margin-top:3px; font-size:8pt; color:var(--muted); text-align:right; }

@page { size:A4 portrait; margin:0; }
@media print { html{background:#fff;} .sheet{margin:0; box-shadow:none; width:210mm; height:297mm; min-height:0; overflow:hidden;} }
</style>
</head>
<body>
<main class="sheet">
  <header>
    <div>
      <p class="role">事務所マニュアル（2枚目）</p>
      <h1>Wチェックができない日の対応</h1>
      <p class="sub">二人そろわない日は、<u>翌日の日勤</u>がWチェックして完了させる</p>
    </div>
    <div class="when">${MONTH}月のスケジュール<br>シフトに関係なく、曜日・祝日で決める</div>
  </header>

  <div class="reason">理由：<b>日曜日・祝日は日勤1人・遅番1人</b>、<b>月曜日は遅番が1人</b>のため、二人でのWチェックができない。<b>二人そろわない分は予約受付表（紙）にだけレ点</b>入れて、<b>翌日の日勤</b>が完了させる。</div>

  <h2 class="sec"><span class="n">1</span>日曜日・祝日と月曜日の流れ</h2>
  <div class="two">
    <div class="dcard">
      <div class="dh">日曜日・祝日<small>日勤 1人／遅番 1人</small></div>
      <div class="flow">
        <div class="step ng"><div class="who">日勤<small>夕方</small><span class="pp">●</span></div><div class="what"><span class="st x">✗</span>1人のためWチェック不可。<b>予約受付表（紙）にレ点のみ</b></div></div>
        <p class="dn2">▼</p>
        <div class="step ng"><div class="who">遅番<small>業務終了後</small><span class="pp">●</span></div><div class="what"><span class="st x">✗</span>1人のためWチェック不可。<b>予約受付表（紙）にレ点のみ</b></div></div>
        <p class="dn2">▼</p>
        <div class="step fin"><div class="who">翌日 朝<small>日勤</small><span class="pp">●●●</span></div><div class="what"><span class="st o">○</span><b>翌日の日勤がWチェック</b>して完了。配車ボードに「済」、<b>日勤の名前でサイン</b></div></div>
      </div>
    </div>
    <div class="dcard">
      <div class="dh">月曜日<small>日勤 2人以上／遅番 1人</small></div>
      <div class="flow">
        <div class="step"><div class="who">日勤<small>夕方</small><span class="pp">●●●</span></div><div class="what"><span class="st o">○</span>二人でWチェック可。予約受付表（紙）と配車ボードにレ点、<b>日勤の名前でサイン</b></div></div>
        <p class="dn2">▼</p>
        <div class="step ng"><div class="who">遅番<small>業務終了後</small><span class="pp">●</span></div><div class="what"><span class="st x">✗</span>1人のためWチェック不可。<b>予約受付表（紙）にレ点のみ</b></div></div>
        <p class="dn2">▼</p>
        <div class="step fin"><div class="who">火曜 朝<small>日勤</small><span class="pp">●●●</span></div><div class="what"><span class="st o">○</span><b>翌日の日勤が朝チェック</b>（Wチェック後）して完了。<b>日勤の名前でサイン</b></div></div>
      </div>
    </div>
  </div>

  <h2 class="sec"><span class="n">2</span>${MONTH}月のスケジュール（Wチェックできない日は翌日）</h2>
  <table class="cal">
    <tr><th>日</th><th>月</th><th>火</th><th>水</th><th>木</th><th>金</th><th>土</th></tr>
${rows}  </table>
  <div class="legend">
    <div><b>当日で完了</b>火〜土（祝日を除く）。日勤・遅番とも二人でWチェックできる。ふだんどおり</div>
    <div><b>→ 翌日の朝</b>月曜日。日勤はWチェック、遅番は1人で予約受付表（紙）のみ。翌日の日勤が朝にWチェック</div>
    <div><b>→ 翌日がWチェック</b>日曜日・祝日。日勤・遅番とも1人で予約受付表（紙）のみ。翌日の日勤が完了</div>
  </div>
  <p class="note">【${MONTH}月】日曜日・祝日（<b>${listD}</b>）は、翌日の日勤がWチェック。月曜日（<b>${listB}</b>）は、翌日の日勤が朝にWチェック。<br>祝日：11月3日（文化の日）、11月23日（勤労感謝の日）。祝日は日曜日と同じ扱い。月曜日が祝日のとき（23日）も、日曜日・祝日の扱い。</p>

  <p class="foot">富士タクシー　配車管理 / 事務所マニュアル：Wチェックの運用（2枚目）（2026年11月版）</p>
</main>
</body>
</html>
`;
fs.writeFileSync("w-check-2.html", html);
console.log("B:" + listB, "D:" + listD);
