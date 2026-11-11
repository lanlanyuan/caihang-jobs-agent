/* 命令行预抓取：把真实岗位写入 data/jobs-cache.json
   用途：比赛/演示现场可能没有网络，提前跑一次即可离线使用真实数据。
   运行： npm run sync */
import { syncSources } from "../lib/sources.js";
import { loadJson, saveJson, CACHE_FILE, SOURCES_FILE, ROOT } from "../lib/store.js";
import path from "node:path";

const cfg = loadJson(SOURCES_FILE);
if (!cfg) { console.error("缺少 config/sources.json"); process.exit(1); }
console.log("开始同步公开岗位数据源…\n");
const t0 = Date.now();
const r = await syncSources(cfg);
for (const x of r.report) {
  console.log(`${x.skipped ? "⏸" : x.ok ? "✓" : "✕"}  ${x.name.padEnd(34)} ${String(x.count).padStart(5)} 条  ${x.reason || x.detail || ""}`);
  (x.fails || []).forEach(f => console.log("    └ " + f));
}
if (!r.jobs.length) { console.error("\n所有源均未返回数据，未覆盖已有缓存。"); process.exit(2); }
saveJson(CACHE_FILE, { jobs: r.jobs, report: r.report, fetchedAt: r.fetchedAt });
console.log(`\n完成：${r.jobs.length} 条去重后的真实岗位，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("缓存：" + path.relative(ROOT, CACHE_FILE));
