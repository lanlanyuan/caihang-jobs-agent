/* 端到端自验：先 `npm start`，再 `node scripts/e2e.js`
   覆盖 状态 / 数据源 / 岗位检索 / 岗位详情 / 文本解析 / 岗位匹配 /
        简历文件上传（TXT / DOCX / PDF）/ 静态资源，共 12 项。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:8081";
let pass = 0, fail = 0;

function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? "  " + extra : ""}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  " + extra : ""}`); }
}
async function get(p) {
  const r = await fetch(BASE + p);
  return { code: r.status, body: await r.text(), json: null };
}
async function getJson(p) {
  const r = await fetch(BASE + p);
  const t = await r.text();
  try { return { code: r.status, data: JSON.parse(t) }; }
  catch { return { code: r.status, data: null, raw: t.slice(0, 200) }; }
}
async function postJson(p, obj) {
  const r = await fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
  const t = await r.text();
  try { return { code: r.status, data: JSON.parse(t) }; }
  catch { return { code: r.status, data: null, raw: t.slice(0, 200) }; }
}
async function upload(file) {
  const buf = fs.readFileSync(file);
  const fd = new FormData();
  fd.append("resume", new Blob([buf]), path.basename(file));
  fd.append("useLLM", "0");
  const r = await fetch(BASE + "/api/upload-resume", { method: "POST", body: fd });
  const t = await r.text();
  try { return { code: r.status, data: JSON.parse(t) }; }
  catch { return { code: r.status, data: null, raw: t.slice(0, 200) }; }
}

console.log(`\n才航 · 端到端自验  ${BASE}\n`);

/* 1. 服务状态 */
{
  const r = await getJson("/api/status");
  const d = r.data || {};
  ok("GET /api/status", r.code === 200 && d.ok === true,
    `jobCount=${d.jobCount} sources=${(d.sources || []).length}`);
  ok("真实岗位规模 > 10000", d.jobCount > 10000, `jobCount=${d.jobCount}`);
  ok("缓存有抓取时间", !!d.fetchedAt, String(d.fetchedAt || ""));
  ok("数据分布可核验", !!d.summary?.bySource && Object.keys(d.summary.bySource).length >= 5,
    Object.keys(d.summary?.bySource || {}).join("/"));
}
/* 2. 健康检查 / 数据源清单 */
{
  const h = await getJson("/api/health");
  ok("GET /api/health", h.code === 200 && h.data?.ok === true);
  const s = await getJson("/api/sources");
  ok("GET /api/sources", s.code === 200 && (s.data?.sources || []).length >= 5,
    `${(s.data?.sources || []).length} 个源`);
}
/* 3. 岗位检索 */
let firstId = "";
{
  const r = await getJson("/api/jobs?q=" + encodeURIComponent("算法") + "&limit=5");
  const items = r.data?.items || [];
  firstId = items[0]?.id || "";
  ok("GET /api/jobs?q=算法", r.code === 200 && items.length > 0,
    `total=${r.data?.total} 命中=${(items[0]?.displayTitle || items[0]?.title || "").slice(0, 40)}`);
  ok("搜索结果确实相关", /算法|algorithm|machine learning/i.test(items[0]?.title || ""),
    `rel=${items[0]?.relevance}`);
  ok("岗位带溯源链接", !!items[0]?.originUrl, (items[0]?.originUrl || "").slice(0, 80));
  ok("长标题有列表短标题", !!items[0]?.displayTitle && items[0].displayTitle.length < items[0].title.length,
    (items[0]?.displayTitle || "").slice(0, 40));
  const cn = await getJson("/api/jobs?onlyChina=1&limit=3");
  ok("筛选 onlyChina", cn.code === 200 && (cn.data?.items || []).length > 0, `total=${cn.data?.total}`);
}
/* 4. 岗位详情 */
{
  const r = await getJson("/api/job?id=" + encodeURIComponent(firstId));
  ok("GET /api/job?id=", r.code === 200 && !!r.data?.job?.title, r.data?.job?.title || r.data?.error || "");
}
/* 5. 简历文本解析 + 匹配 */
const resumeText = fs.readFileSync(path.join(ROOT, "samples", "示例简历.txt"), "utf8");
let profile = null;
{
  const r = await postJson("/api/parse-resume", { text: resumeText, useLLM: false });
  profile = r.data?.profile || null;
  ok("POST /api/parse-resume", r.code === 200 && !!profile,
    `degree=${profile?.degree} skills=${(profile?.skills || []).slice(0, 3).join(",")}`);
  ok("画像含期望岗位", (profile?.expectedRoles || []).length > 0, (profile?.expectedRoles || []).join("/"));
}
{
  const r = await postJson("/api/match", { profile, limit: 5, sort: "score" });
  const items = r.data?.items || [];
  ok("POST /api/match", r.code === 200 && items.length > 0,
    `total=${r.data?.total} 首位=${(items[0]?.displayTitle || items[0]?.title || "").slice(0, 32)} 分数=${items[0]?.score ?? "-"}`);
  ok("匹配结果可解释", !!items[0]?.reasons || !!items[0]?.matchReasons || !!items[0]?.why,
    JSON.stringify(items[0]?.reasons || items[0]?.matchReasons || []).slice(0, 120));
}
/* 6. 三种格式简历上传 */
for (const [name, file] of [["TXT", "示例简历.txt"], ["DOCX", "示例简历.docx"], ["PDF", "示例简历.pdf"]]) {
  const p = path.join(ROOT, "samples", file);
  if (!fs.existsSync(p)) { ok(`上传 ${name}`, false, "样例文件缺失"); continue; }
  const r = await upload(p);
  const d = r.data || {};
  ok(`POST /api/upload-resume (${name})`, r.code === 200 && d.ok === true && (d.file?.chars || 0) > 50,
    `method=${d.file?.method} chars=${d.file?.chars} 匹配=${d.match?.items?.length ?? 0}`);
  ok(`  ${name} 生成画像`, (d.profile?.skills || []).length > 0,
    `skills=${(d.profile?.skills || []).slice(0, 4).join(",")}`);
}
/* 7. 静态资源 */
for (const [p, needle] of [["/", "才航"], ["/style.css", ""], ["/app.js", ""]]) {
  const r = await get(p);
  ok(`GET ${p}`, r.code === 200 && r.body.length > 100 && (!needle || r.body.includes(needle)),
    `${r.body.length} bytes`);
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
