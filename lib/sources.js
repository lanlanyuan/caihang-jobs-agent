/* 真实岗位数据源连接器
   —— 只连公开、无需密钥、可核验的接口；每条岗位都保留原始链接、来源、发布时间与抓取时间。
   合规：不绕过登录/鉴权；不抓 robots 或 ToS 禁止的商业招聘平台；限速 + 超时 + 明确 UA。 */
import { extractSkills, detectCategory, detectCities, isNewGrad, isSenior,
  htmlToText, fixMojibake, hashId, truncate, parseDate, uniq } from "./text.js";

const UA = "CaiHangJobsAssistant/3.0 (+public-welfare graduate job search; local user)";
const TIMEOUT = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const GAP = Number(process.env.SOURCE_MIN_INTERVAL_MS || 260);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastStart = 0;
async function gate() {
  const now = Date.now();
  const at = Math.max(now, lastStart + GAP);
  lastStart = at;
  if (at > now) await sleep(at - now);
}
async function get(url, asJson = true, timeout = TIMEOUT) {
  await gate();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": asJson ? "application/json" : "*/*", "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" }
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return asJson ? await res.json() : await res.text();
  } finally { clearTimeout(timer); }
}

/* ---------- 统一岗位结构 ---------- */
function makeJob(p) {
  // 技能只从标题/标签/摘要前 400 字抽取，避免长 JD 里的泛词把画像污染
  const text = `${p.title || ""} ${(p.tags || []).join(" ")} ${p.location || ""} ${truncate(p.description || "", 400)}`;
  const skills = p.skills && p.skills.length ? p.skills : extractSkills(text);
  const category = p.category || detectCategory(text) || "其他";
  const cities = uniq([...(p.cities || []), ...detectCities(`${p.location || ""} ${p.title || ""}`)]);
  const grad = p.isNewGrad ?? (isNewGrad(text) && !isSenior(`${p.title || ""} ${p.level || ""}`));
  const sal = salaryOf(p);
  const fullTitle = fixMojibake(truncate(p.title, 120)) || "未命名岗位";
  return {
    id: p.id || hashId(`${p.sourceId}|${p.externalId || p.url}`),
    type: p.type || "job",                        // job=具体职位 / campus=国内校招岗位
    title: fullTitle,
    displayTitle: displayTitleOf(fullTitle),
    company: fixMojibake(truncate(p.company, 80)) || "未标注公司",
    location: fixMojibake(truncate(p.location, 100)) || "地点未标注",
    city: p.city || cities[0] || "",
    cities,
    salaryText: sal.text,
    salaryMin: sal.min, salaryMax: sal.max, salaryCurrency: p.salaryCurrency || "",
    deadline: p.deadline || "",
    level: p.level || (isSenior(`${p.title || ""}`) ? "中高级" : grad ? "应届/初级友好" : "不限"),
    category,
    tags: uniq((p.tags || []).map(t => fixMojibake(String(t)))).slice(0, 12),
    skills: uniq(skills).slice(0, 18),
    description: fixMojibake(truncate(p.description || "", 420)),
    url: p.url || "",
    originUrl: p.originUrl || p.url || "",
    sourceId: p.sourceId,
    sourceName: p.sourceName,
    sourceUrl: p.sourceUrl,
    credit: p.credit || "",
    publishedAt: parseDate(p.publishedAt),
    fetchedAt: p.fetchedAt || new Date().toISOString(),
    isRemote: !!(p.isRemote || /remote|anywhere|worldwide|distributed/i.test(p.location || "")),
    isNewGrad: !!grad,
    isChina: !!(p.isChina || /china|中国|全国|北京|上海|深圳|广州|杭州|成都|武汉|西安|南京|苏州|beijing|shanghai|shenzhen/i.test(`${p.location || ""} ${p.title || ""}`)),
    externalId: p.externalId || null,
    board: p.board || null
  };
}
/* 校招公告常把十几个岗位名挤在同一格，列表里收成「首个岗位 + 等 N 个方向」；
   title 保留完整原文，详情弹窗与 CSV 导出都用完整原文，不损失真实数据。 */
function displayTitleOf(title) {
  const t = String(title || "").trim();
  if (t.length <= 28) return t;
  const parts = t.split(/[、，,；;｜|]/).map(s => s.trim()).filter(Boolean);
  const raw = parts[0] && parts[0].length <= 28 ? parts[0] : t.slice(0, 22);
  const head = raw.length > 24 ? raw.slice(0, 24) + "…" : raw;
  return parts.length > 1 ? `${head} 等 ${parts.length} 个方向` : head + "…";
}
function salaryOf(p) {
  if (p.salaryText) return { text: p.salaryText, min: p.salaryMin ?? null, max: p.salaryMax ?? null };
  let mn = Number(p.salaryMin) || 0, mx = Number(p.salaryMax) || 0;
  const cur = p.salaryCurrency || "";
  // RemoteOK 等源偶发返回放大 1000 倍的数值，按常识归一（>100 万视为放大值）
  if (mn > 1e6) mn = Math.round(mn / 1000);
  if (mx > 1e6) mx = Math.round(mx / 1000);
  if (!mn && !mx) return { text: "", min: null, max: null };
  const symbol = ({ USD: "$", CNY: "¥", EUR: "€", GBP: "£", INR: "₹" })[cur] || (cur ? cur + " " : "");
  const fmt = v => v >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + "k" : String(v);
  const range = mn && mx ? `${fmt(mn)}–${fmt(mx)}` : fmt(mx || mn);
  return { text: `${symbol}${range}${p.salaryPeriod ? " / " + p.salaryPeriod : ""}`, min: mn || null, max: mx || null };
}

/* ---------- 国内 2027 届校招岗位库（GitHub 开源，每日更新） ---------- */
const asArray = v => Array.isArray(v) ? v.filter(Boolean).map(String) : (v ? [String(v)] : []);
function mapCampusRow(x, src, i) {
  const company = String(x["公司名称"] || "").trim();
  if (!company || /筛选前必看|填写说明|必读|示例/.test(company)) return null;
  const roles = String(x["招聘岗位"] || "").replace(/\s+/g, " ").trim();
  const places = [...asArray(x["工作地点"]), ...asArray(x["工作地点文本"])].filter((v, k, a) => a.indexOf(v) === k);
  const industry = asArray(x["行业大类"]).join("/");
  const nature = asArray(x["企业性质"]).join("/");
  const audience = asArray(x["招聘对象"]).join("/");
  const batch = asArray(x["批次"]).join("/");
  const written = asArray(x["是否需要笔试"]).join("/");
  const notice = String(x["官方公告"] || "").trim();
  const apply = String(x["投递方式"] || "").trim();
  const url = /^https?:/i.test(apply) ? apply : (/^https?:/i.test(notice) ? notice : "");
  const originUrl = /^https?:/i.test(notice) ? notice : url;
  const deadline = String(x["截止时间"] || "").trim();
  const note = String(x["备注/提示"] || "").trim();
  const desc = [
    roles ? `招聘岗位：${roles}` : "",
    `工作地：${places.join("、") || "未标注"}｜招聘对象：${audience || "应届毕业生"}｜批次：${batch || "未标注"}`,
    `企业性质：${nature || "未标注"}｜行业：${industry || "未标注"}｜笔试：${written || "未标注"}`,
    deadline ? `投递截止：${deadline}` : "",
    note && note !== company ? `备注：${note}` : "",
    url ? "" : "该条未提供在线投递链接，请到来源仓库或企业官网核对。"
  ].filter(Boolean).join("\n");
  const title = roles ? truncate(roles, 52) : `${company} ${audience || batch || "校园"}招聘`;
  const cities = places.map(p => /全国多地|全国/.test(p) ? "全国" : p);
  return makeJob({
    sourceId: src.id, sourceName: src.name, sourceUrl: src.credit, credit: src.credit,
    type: "campus", externalId: `${company}|${i}`,
    title, company, location: places.join(" / ") || (cities[0] || "未标注"),
    city: cities[0] || "", cities,
    category: detectCategory(`${roles} ${industry} ${note}`) || "其他",
    description: desc,
    tags: [nature, industry, batch, audience, written, "2027校招", "国内岗位"].filter(Boolean),
    level: /实习/.test(batch + roles) ? "实习" : "应届/校招",
    deadline, url, originUrl,
    publishedAt: String(x["更新时间"] || "").replace(/\./g, "/"),
    isNewGrad: true, isChina: true,
    isRemote: /海外|remote|远程/i.test(places.join(""))
  });
}
async function githubJson(src, limit) {
  let data = null, via = "";
  // 优先 raw（最快）；preferBlob=true 或 raw 不可达时，走 GitHub Contents → Blob API（base64）
  if (!src.preferBlob) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
      try {
        const r = await fetch(src.raw, { signal: ctrl.signal, headers: { "User-Agent": UA } });
        if (r.ok) { data = await r.json(); via = "raw.githubusercontent.com"; }
      } finally { clearTimeout(t); }
    } catch { /* 走 API */ }
  }
  if (!Array.isArray(data)) {
    const meta = await get(src.api);
    let content = meta.content;
    if (!content || meta.size > 1024 * 1024) {
      const blob = await get(src.blobApi + meta.sha, true, 90000);
      content = blob.content;
    }
    if (!content) throw new Error("GitHub 未返回 jobs.json 内容");
    data = JSON.parse(Buffer.from(content, "base64").toString("utf8"));
    via = "GitHub Contents/Blob API";
  }
  if (!Array.isArray(data)) throw new Error("jobs.json 格式不是数组");
  let updateTime = "";
  try { const s = await get(src.summaryApi); updateTime = JSON.parse(Buffer.from(s.content, "base64").toString("utf8")).update_time || ""; } catch { /* 可选 */ }
  const jobs = [];
  for (let i = 0; i < data.length && jobs.length < limit; i++) {
    const j = mapCampusRow(data[i], src, i);
    if (j) jobs.push(j);
  }
  return { jobs, fails: [], detail: `原始 ${data.length} 条，清洗后 ${jobs.length} 条；仓库标注更新时间 ${updateTime || "见仓库"}；下载通道 ${via}` };
}

/* ---------- 其他公开职位源 ---------- */
async function greenhouse(src, limit) {
  const perBoard = Math.max(40, Math.floor(limit / src.boards.length));
  const results = await Promise.allSettled(src.boards.map(async board => {
    const data = await get(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`);
    const list = Array.isArray(data.jobs) ? data.jobs : [];
    const sorted = list.sort((a, b) => new Date(b.first_published || b.updated_at || 0) - new Date(a.first_published || a.updated_at || 0));
    return sorted.slice(0, perBoard).map(j => makeJob({
      sourceId: src.id, sourceName: src.name, sourceUrl: src.credit, credit: src.credit,
      externalId: `${board}:${j.id}`, board,
      title: j.title, company: j.company_name || board,
      location: j.location?.name || "", url: j.absolute_url,
      tags: ["Greenhouse", "企业官网", board],
      level: /intern|new grad|graduate|entry|junior|university/i.test(j.title) ? "实习/应届" : null,
      publishedAt: j.first_published || j.updated_at,
      description: ""   // 职位板列表不含 JD；详情弹窗按需拉取官方 JD，不编造摘要
    }));
  }));
  const jobs = [], fails = [];
  results.forEach((r, i) => r.status === "fulfilled" ? jobs.push(...r.value) : fails.push(`${src.boards[i]}: ${r.reason?.message}`));
  return { jobs, fails, detail: `${src.boards.length} 个企业职位板` };
}
async function jobicy(src, limit) {
  const results = await Promise.allSettled(src.urls.map(u => get(u)));
  const jobs = [], fails = [];
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") { fails.push(`feed${i + 1}: ${r.reason?.message}`); return; }
    for (const j of (r.value.jobs || [])) {
      jobs.push(makeJob({
        sourceId: src.id, sourceName: src.name, sourceUrl: src.credit, credit: src.credit,
        externalId: j.id, title: j.jobTitle, company: j.companyName,
        location: j.jobGeo || "Remote", url: j.url,
        description: htmlToText(j.jobDescription || j.jobExcerpt || "").slice(0, 1600),
        tags: [...asArray(j.jobIndustry), ...asArray(j.jobType)],
        level: j.jobLevel || null,
        salaryMin: j.salaryMin ?? j.annualSalaryMin, salaryMax: j.salaryMax ?? j.annualSalaryMax,
        salaryCurrency: j.salaryCurrency || "USD",
        salaryPeriod: /year|annual/i.test(j.salaryPeriod || "") ? "年" : (j.salaryPeriod || ""),
        publishedAt: j.pubDate,
        isRemote: true
      }));
    }
  });
  return { jobs: jobs.slice(0, limit), fails, detail: `${src.urls.length} 个分类 feed` };
}
async function remoteok(src, limit) {
  const data = await get(src.url);
  const list = (Array.isArray(data) ? data : []).filter(x => x && x.position);
  const jobs = list.slice(0, limit).map(j => makeJob({
    sourceId: src.id, sourceName: src.name, sourceUrl: src.credit, credit: src.credit,
    externalId: j.id, title: j.position, company: j.company,
    location: j.location || "Remote", url: j.url || j.apply_url,
    description: htmlToText(j.description || "").slice(0, 1600),
    tags: asArray(j.tags), salaryMin: j.salary_min, salaryMax: j.salary_max,
    salaryCurrency: "USD", salaryPeriod: "年", publishedAt: j.date || j.epoch,
    isRemote: true
  }));
  return { jobs, fails: [], detail: "公开职位 feed" };
}
async function himalayas(src, limit) {
  const jobs = [], fails = [];
  let cursor = null, totalCount = 0;
  for (let page = 0; page < (src.pages || 3); page++) {
    const u = src.url + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    try {
      const data = await get(u);
      totalCount = data.totalCount || totalCount;
      for (const j of (data.jobs || [])) {
        jobs.push(makeJob({
          sourceId: src.id, sourceName: src.name, sourceUrl: src.credit, credit: src.credit,
          externalId: j.guid || j.applicationLink, title: j.title, company: j.companyName,
          location: (j.locationRestrictions || []).join(" / ") || "Remote",
          url: j.applicationLink, description: htmlToText(j.description || j.excerpt || "").slice(0, 1600),
          tags: [...asArray(j.categories), ...asArray(j.seniority)],
          level: (j.seniority || [])[0] || null,
          salaryMin: j.minSalary, salaryMax: j.maxSalary, salaryCurrency: j.currency || "",
          salaryPeriod: j.salaryPeriod === "annual" ? "年" : (j.salaryPeriod || ""),
          publishedAt: j.pubDate,
          isRemote: !(j.locationRestrictions || []).length
        }));
      }
      cursor = data.nextCursor;
      if (!cursor) break;
    } catch (e) { fails.push(`page${page + 1}: ${e.message}`); break; }
  }
  return { jobs: jobs.slice(0, limit), fails, detail: `职位库共 ${totalCount || "?"} 条，游标取最新 ${Math.min(jobs.length, limit)} 条` };
}

const ADAPTERS = { "github-json": githubJson, greenhouse, jobicy, remoteok, himalayas };

/* ---------- 同步入口 ---------- */
export async function syncSources(config) {
  const fetchedAt = new Date().toISOString();
  const all = [], report = [];
  await Promise.all((config.sources || []).map(async src => {
    if (src.enabled === false) {
      report.push({ id: src.id, name: src.name, ok: true, skipped: true, count: 0, reason: "已关闭", kind: src.kind });
      return;
    }
    const t0 = Date.now();
    try {
      const fn = ADAPTERS[src.type];
      if (!fn) throw new Error("未知源类型 " + src.type);
      const r = await fn(src, src.maxItems || config.limitPerSource || 1200);
      const list = r.jobs.map(j => ({ ...j, fetchedAt }));
      all.push(...list);
      report.push({
        id: src.id, name: src.name, kind: src.kind, ok: true, count: list.length,
        detail: r.detail || "", fails: (r.fails || []).slice(0, 4),
        url: src.credit || "", elapsedMs: Date.now() - t0,
        reason: (r.fails || []).length ? `部分子源失败 ${r.fails.length} 个` : ""
      });
    } catch (e) {
      report.push({ id: src.id, name: src.name, kind: src.kind, ok: false, count: 0,
        reason: e.message, url: src.credit || "", elapsedMs: Date.now() - t0 });
    }
  }));
  // 去重：同一原始链接，或同公司+同标题只保留一条
  const seen = new Set(); const jobs = [];
  for (const j of all) {
    // 校招岗位常共用同一个投递页，按「公司+岗位+日期」去重；其他源按原始链接去重
    const k = (j.type === "campus"
      ? `${j.company}|${j.title}|${j.publishedAt || ""}`
      : (j.url && /^https?:/.test(j.url) ? j.url : j.title + "|" + j.company)).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); jobs.push(j);
  }
  return { jobs, report, fetchedAt };
}
