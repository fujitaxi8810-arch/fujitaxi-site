import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Vercelはビルドごとにコミットのハッシュを環境変数で渡してくれるので、
// それをそのままビルドIDとして使う（ローカルビルド時は現在時刻で代用）。
const buildId = process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now());

const outPath = join(__dirname, '..', 'public', 'kintai-build.json');
writeFileSync(outPath, JSON.stringify({ buildId }));
console.log(`[write-build-info] ${outPath} -> ${buildId}`);
