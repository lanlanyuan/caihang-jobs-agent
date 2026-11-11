/* 才航 · 真实岗位 + 简历上传匹配  —— 本地服务（Node 18+，核心零依赖）
   启动： node server.js      打开： http://127.0.0.1:8081
   数据： 公开可核验的职位接口 + 开源国内校招汇总，见 config/sources.json
   简历： multipart 上传 PDF/DOCX/TXT → 内存解析 → 画像 → 可解释匹配，不落盘、不外传 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { syncSources } from "./lib/sources.js";
import { parseMultipart, extractResume, MAX_UPLOAD } from "./lib/documents.js";
import { parseResumeText, queryJobs, summarize, LLM } from "./lib/matcher.js";
import { loadJson, saveJson, loadCache, CACHE_FILE, SOURCES_FILE, ROOT } from "./lib/store.js";
import { htmlToText } from "./lib/text.js";

/* ---------- .env ---------- */
(function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
})();

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || "127.0.0.1";
const CONFIG = loadJson(SOURCES_FILE, { sources: [] });

/* ---------- 岗位缓存 ---------- */
let cache = loadCache() || { jobs: [], report: [], fetchedAt: null };
let syncing = false;
const details = new Map();

async function doSync(force = false) {
  if (syncing) return { ok: false, error: "正在同步中，请稍候" };
  if (!force && cache.jobs.length && Date.now() - new Date(cache.fetchedAt).getTime() < 30 * 60 * 1000) {
    return { ok: true, cached: true, jobCount: cache.jobs.length, report: cache.report };
  }
  syncing = true;
  try {
    const r = await syncSources(CONFIG);
    // 全部源都失败时保留旧缓存，避免把真实数据清空成 0
    if (!r.jobs.length && cache.jobs.length) {
      return { ok: false, error: "所有数据源本次均未返回数据，已保留上次抓取结果", jobCount: cache.jobs.length, report: r.report };
    }
    cache = { jobs: r.jobs, report: r.report, fetchedAt: r.fetchedAt };
    saveJson(CACHE_FILE, cache);
    details.clear();
    return { ok: true, jobCount: r.jobs.length, report: r.report, fetchedAt: r.fetchedAt };
  } finally { syncing = false; }
}

/* ---------- HTTP helpers ---------- */
function json(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length,
    "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(b);
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > MAX_UPLOAD + 65536) { reject(new Error("文件过大（上限 12MB）")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
async function readJson(req) {
  const raw = await readRaw(req);
  try { return raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { throw new Error("请求体需为 JSON"); }
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "/index.html" : urlPath.split("?")[0];
  const file = path.join(ROOT, "public", path.normalize(rel).replace(/^([.][.][/\\])+/, ""));
  if (!file.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end("forbidden"); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); return res.end("404 not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}
function parseOpts(u, body = {}) {
  const arr = k => (body[k] || (u.searchParams.get(k) ? u.searchParams.get(k).split(",") : []));
  const bool = k => body[k] === true || body[k] === "1" || u.searchParams.get(k) === "1";
  return {
    q: body.q ?? u.searchParams.get("q") ?? "",
    sources: arr("sources"), categories: arr("categories"), cities: arr("cities"), types: arr("types"),
    onlyNewGrad: bool("onlyNewGrad"), onlySalary: bool("onlySalary"), onlyChina: bool("onlyChina"),
    sort: body.sort || u.searchParams.get("sort") || "score",
    limit: Math.min(100, Math.max(1, Number(body.limit ?? u.searchParams.get("limit")) || 20)),
    offset: Math.max(0, Number(body.offset ?? u.searchParams.get("offset")) || 0),
    profile: body.profile || null
  };
}

/* ---------- 岗位详情（按需拉取官方 JD） ---------- */
async function jobDetail(id) {
  const job = cache.jobs.find(j => j.id === id);
  if (!job) return null;
  if (details.has(id)) return { ...job, ...details.get(id) };
  let description = job.description, sourceUrl = job.originUrl;
  if (job.board && job.externalId) {
    try {
      const jdId = String(job.externalId).split(":").pop();
      const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${job.board}/jobs/${jdId}`, {
        headers: { "User-Agent": "CaiHangJobsAssistant/3.0" }
      });
      if (r.ok) {
        const d = await r.json();
        description = htmlToText(d.content || "").slice(0, 6000) || description;
        sourceUrl = d.absolute_url || sourceUrl;
      }
    } catch { /* 详情失败不影响列表 */ }
  }
  details.set(id, { description, sourceUrl });
  return { ...job, description, sourceUrl };
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  try {
    const p = u.pathname;

    if (p === "/api/status") {
      return json(res, 200, {
        ok: true, jobCount: cache.jobs.length, fetchedAt: cache.fetchedAt, syncing,
        summary: summarize(cache.jobs), report: cache.report,
        llm: { configured: LLM.configured, model: LLM.configured ? LLM.model : null },
        sources: (CONFIG.sources || []).map(s => ({ id: s.id, name: s.name, kind: s.kind, enabled: s.enabled !== false,
          url: s.credit || s.api || s.url || "", desc: s.desc || "" })),
        cacheFile: path.relative(ROOT, CACHE_FILE)
      });
    }
    if (p === "/api/sync" && req.method === "POST") {
      const r = await doSync(true);
      return json(res, 200, { ...r, fetchedAt: cache.fetchedAt, summary: summarize(cache.jobs) });
    }
    if (p === "/api/sources") return json(res, 200, { ok: true, sources: CONFIG.sources, limitPerSource: CONFIG.limitPerSource });

    if (p === "/api/jobs") {
      const opts = parseOpts(u);
      const r = queryJobs(cache.jobs, opts);
      return json(res, 200, { ok: true, ...r, fetchedAt: cache.fetchedAt });
    }
    if (p === "/api/match" && req.method === "POST") {
      const body = await readJson(req);
      const opts = parseOpts(u, body);
      const r = queryJobs(cache.jobs, opts);
      return json(res, 200, { ok: true, ...r, profile: body.profile || null, fetchedAt: cache.fetchedAt });
    }
    if (p === "/api/parse-resume" && req.method === "POST") {
      const body = await readJson(req);
      const text = String(body.text || "");
      if (text.trim().length < 10) return json(res, 400, { ok: false, error: "简历文本太短（至少 10 个字）" });
      const profile = await parseResumeText(text, body.useLLM !== false);
      return json(res, 200, { ok: true, profile });
    }
    if (p === "/api/upload-resume" && req.method === "POST") {
      const ct = req.headers["content-type"] || "";
      let filePart, text = "", useLLM = true;
      if (/multipart\/form-data/i.test(ct)) {
        const parts = parseMultipart(await readRaw(req), ct);
        filePart = parts.find(x => x.filename);
        const field = name => parts.find(x => !x.filename && x.name === name)?.data.toString("utf8");
        useLLM = field("useLLM") !== "0";
        if (!filePart) {
          text = field("text") || "";
          if (text.trim().length < 10) return json(res, 400, { ok: false, error: "请选择简历文件，或粘贴至少 10 个字的简历文本" });
        }
      } else {
        const body = await readJson(req);
        text = String(body.text || "");
        useLLM = body.useLLM !== false;
      }
      let doc;
      if (filePart) doc = await extractResume(filePart);
      else doc = { filename: "粘贴文本", bytes: Buffer.byteLength(text), ext: ".txt", method: "粘贴文本",
        text, chars: text.length, warnings: [], preview: text.slice(0, 400) };
      const resumeText = doc.text;
      const profile = await parseResumeText(resumeText, useLLM);
      const opts = parseOpts(u, { profile, limit: 12, sort: "score", onlyNewGrad: false });
      const match = queryJobs(cache.jobs, opts);
      return json(res, 200, {
        ok: true,
        file: { filename: doc.filename, bytes: doc.bytes, ext: doc.ext, method: doc.method,
          chars: doc.chars, warnings: doc.warnings, preview: doc.preview },
        profile, match: { total: match.total, items: match.items },
        jobCount: cache.jobs.length, fetchedAt: cache.fetchedAt
      });
    }
    if (p === "/api/job") {
      const d = await jobDetail(u.searchParams.get("id") || "");
      return d ? json(res, 200, { ok: true, job: d }) : json(res, 404, { ok: false, error: "未找到该岗位" });
    }
    if (p === "/api/health") return json(res, 200, { ok: true, jobs: cache.jobs.length, uptime: process.uptime() });
    if (p.startsWith("/api/")) return json(res, 404, { ok: false, error: "unknown api: " + p });
    return serveStatic(res, p);
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

/* 端口被占用（例如旧版服务仍在运行）时自动顺延，避免启动即崩溃 */
function listen(port, attempt = 0) {
  server.once("error", e => {
    if (e.code === "EADDRINUSE" && attempt < 6) {
      console.log(`  端口 ${port} 已被占用（可能旧版服务仍在运行），改用 ${port + 1}…`);
      server.removeAllListeners("listening");   // 丢弃上一次失败的 listen 回调，避免重复启动日志
      listen(port + 1, attempt + 1);
    } else {
      console.error("  服务启动失败：" + e.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const n = cache.jobs.length;
    console.log("\n  才航 · 真实岗位与简历匹配助手");
    console.log(`  ➜  请用浏览器打开： http://${HOST}:${port}`);
    console.log(`  岗位缓存：${n ? n + " 条（" + (cache.fetchedAt || "未知时间") + " 抓取）" : "空，正在后台同步…"}`);
    console.log(`  简历解析：${LLM.configured ? "LLM " + LLM.model : "本地规则（配置 .env 可启用 LLM）"}`);
    console.log(`  数据源：${(CONFIG.sources || []).filter(s => s.enabled !== false).length} 个公开可核验来源\n`);
    // 启动时后台刷新；失败时自动沿用缓存，不阻塞访问
    doSync(false).then(r => {
      if (r.ok && !r.cached) console.log(`  后台同步完成：${r.jobCount} 条真实岗位，已写入 ${path.relative(ROOT, CACHE_FILE)}`);
    }).catch(e => console.log("  后台同步失败（沿用缓存）：" + e.message));
  });
}
listen(PORT);
