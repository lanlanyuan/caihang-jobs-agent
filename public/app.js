/* 才航前端：真实岗位浏览 + 简历上传解析 + 可解释匹配 */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = n => Number(n || 0).toLocaleString("zh-CN");
const fmtSize = b => b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
const truncate = (s, n) => { const t = String(s || ""); return t.length > n ? t.slice(0, n) + "…" : t; };
const CATS = ["软件研发", "算法/AI", "数据", "产品/项目", "设计/创意", "市场/运营", "销售/客服", "财务/金融", "硬件/制造", "人力/行政", "科研/教育", "其他"];

const S = {
  status: null, profile: null, file: null, hasProfile: false,
  items: [], total: 0, busy: false, view: "all",
  filters: { q: "", types: [], categories: [], sources: [], cities: [], onlyNewGrad: false, onlySalary: false, onlyChina: false, sort: "score" },
  checklist: JSON.parse(localStorage.getItem("caihang.checklist") || "[]")
};

/* ---------------- API ---------------- */
async function api(path, opt) {
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({ ok: false, error: "HTTP " + r.status }));
  if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);
  return j;
}
function toast(msg, ms = 2600) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  $("#toastRoot").appendChild(t); setTimeout(() => t.remove(), ms);
}

/* ---------------- 状态栏 ---------------- */
function renderStatus() {
  const s = S.status; if (!s) return;
  $("#txtJobs").textContent = fmtNum(s.jobCount);
  $("#txtSources").textContent = (s.sources || []).filter(x => x.enabled).length;
  $("#txtSync").textContent = s.fetchedAt ? "抓取于 " + fmtDate(s.fetchedAt, true) : "尚未同步";
  const ok = s.jobCount > 0;
  $("#dotApi").className = "dot " + (ok ? "on" : "off");
  $("#txtApi").textContent = ok ? "数据服务已连接" : "岗位数据为空";
  $("#dotLlm").className = "dot " + (s.llm.configured ? "on" : "warn");
  $("#txtLlm").textContent = s.llm.configured ? "LLM " + s.llm.model : "本地规则解析";
  const f = $("#fCategory"), so = $("#fSource"), c = $("#fCity");
  const cats = Object.keys(s.summary.byCategory || {}).sort((a, b) => (s.summary.byCategory[b] || 0) - (s.summary.byCategory[a] || 0));
  f.innerHTML = '<option value="">全部职类</option>' + cats.map(x => `<option value="${esc(x)}">${esc(x)}（${s.summary.byCategory[x]}）</option>`).join("");
  so.innerHTML = '<option value="">全部数据源</option>' + (s.sources || []).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join("");
  const cities = Object.keys(s.summary.byCity || {}).slice(0, 32);
  c.innerHTML = '<option value="">全部地区</option>' + cities.map(x => `<option value="${esc(x)}">${esc(x)}（${s.summary.byCity[x]}）</option>`).join("");
  $("#listCount").textContent = S.checklist.length;
}

/* ---------------- 日期 ---------------- */
function fmtDate(v, withTime) {
  if (!v) return "未标注";
  const d = new Date(v); if (isNaN(d)) return String(v);
  const p = n => String(n).padStart(2, "0");
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return withTime ? `${base} ${p(d.getHours())}:${p(d.getMinutes())}` : base;
}
function ago(v) {
  if (!v) return "发布时间未标注";
  const days = Math.floor((Date.now() - new Date(v).getTime()) / 86400000);
  if (isNaN(days)) return "发布时间未标注";
  if (days < 0) return fmtDate(v);
  if (days === 0) return "今天发布";
  if (days < 30) return `${days} 天前发布`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前发布`;
  return fmtDate(v) + " 发布";
}

/* ---------------- 筛选读取 ---------------- */
function readFilters() {
  const f = S.filters;
  f.q = $("#q").value.trim();
  f.types = $("#fType").value ? [$("#fType").value] : [];
  f.categories = $("#fCategory").value ? [$("#fCategory").value] : [];
  f.sources = $("#fSource").value ? [$("#fSource").value] : [];
  f.cities = $("#fCity").value ? [$("#fCity").value] : [];
  f.sort = $("#fSort").value;
  f.onlyNewGrad = $("#onlyNewGrad").checked;
  f.onlySalary = $("#onlySalary").checked;
  f.onlyChina = $("#onlyChina").checked;
  ["chkGrad", "chkSalary", "chkChina"].forEach((id, i) => {
    const cb = [$("#onlyNewGrad"), $("#onlySalary"), $("#onlyChina")][i];
    $("#" + id).classList.toggle("on", cb.checked);
  });
}
function payload(limit, offset) {
  const f = S.filters;
  return { profile: S.hasProfile ? S.profile : null, q: f.q, types: f.types, categories: f.categories,
    sources: f.sources, cities: f.cities, onlyNewGrad: f.onlyNewGrad, onlySalary: f.onlySalary,
    onlyChina: f.onlyChina, sort: f.sort, limit: limit || 18, offset: offset || 0 };
}

/* ---------------- 岗位列表 ---------------- */
function scoreClass(s) { return s >= 70 ? "" : (s >= 45 ? "mid" : "low"); }
function scoreBreakdownHtml(j) {
  if (!j.breakdown || !j.breakdown.length) return '<div class="small muted">未上传简历，暂无分项打分。</div>';
  const rows = j.breakdown.map(d => {
    const pct = d.max > 0 ? Math.min(100, Math.round(d.value / d.max * 100)) : 0;
    return `<div class="dim"><div class="lab"><span>${esc(d.label)}</span><em>${esc(d.value)} / ${esc(d.max)}</em></div><div class="bar"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  return `<div class="tier"><b>${esc(j.tier || "—")} · ${esc(j.score)} 分</b><span>满分参考 75+ 强匹配</span></div>${rows}
    ${j.advice ? `<div class="advice">💡 ${esc(j.advice)}</div>` : ""}`;
}
function jobCard(j) {
  const added = S.checklist.some(c => c.id === j.id);
  const badges = [];
  if (j.type === "campus") badges.push('<span class="badge campus">国内校招岗位</span>');
  else badges.push('<span class="badge">具体岗位</span>');
  if (j.isNewGrad || j.type === "campus") badges.push('<span class="badge grad">应届友好</span>');
  if (j.category && j.category !== "其他") badges.push(`<span class="badge">${esc(j.category)}</span>`);
  if (j.skills && j.skills.length) badges.push(...j.skills.slice(0, 4).map(x => `<span class="badge">${esc(x)}</span>`));
  const meta = [j.location || "地点未标注", j.level || "", j.salaryText ? "" : ""].filter(Boolean);
  return `<article class="job" data-id="${esc(j.id)}">
    <div class="top">
      <div class="tt"><h3 title="${esc(j.title)}">${esc(j.displayTitle || j.title)}</h3><div class="co">${esc(j.company)}</div></div>
      <div class="score ${scoreClass(j.score)}">${j.score}<small>匹配分</small></div>
    </div>
    <div class="meta">
      <span>📍 ${esc(j.location)}</span>
      ${j.salaryText ? `<span class="sal">💰 ${esc(j.salaryText)}</span>` : ""}
      <span>🕒 ${esc(ago(j.publishedAt))}</span>
      ${j.deadline ? `<span>⏳ 截止 ${esc(j.deadline)}</span>` : ""}
    </div>
    <div class="badges">${badges.join("")}</div>
    ${j.reasons && j.reasons.length ? `<div class="why"><b>匹配依据：</b>${esc(j.reasons.slice(0, 4).join("；"))}</div>` : ""}
    ${j.gaps && j.gaps.length && S.hasProfile ? `<div class="gap">📌 岗位还提到：${esc(j.gaps.join("、"))}（简历中未识别到，可在简历里补充）</div>` : ""}
    <div class="score-detail hide" id="sd-${esc(j.id)}">${scoreBreakdownHtml(j)}</div>
    <div class="desc">${esc((j.description || "该来源未提供岗位摘要，点击「查看原始职位」核对完整 JD。").replace(/\n/g, " · "))}</div>
    <div class="acts">
      ${j.originUrl ? `<a class="btn primary sm" href="${esc(j.originUrl)}" target="_blank" rel="noopener">查看原始职位 ↗</a>` : ""}
      <button class="btn sm" data-act="detail">职位详情</button>
      <button class="btn sm" data-act="score">📊 评分明细</button>
      <button class="btn sm interview" data-act="interview">🔍 查面经</button>
      <button class="btn sm ${added ? "added" : ""}" data-act="add">${added ? "✓ 已加入清单" : "＋ 加入投递"}</button>
    </div>
    <div class="src-line">来源：<a href="${esc(j.sourceUrl || j.originUrl)}" target="_blank" rel="noopener">${esc(j.sourceName)}</a>
      · 抓取于 ${esc(fmtDate(j.fetchedAt, true))} · 原始链接可核验</div>
  </article>`;
}
function renderJobs(append) {
  const box = $("#jobs");
  if (!S.items.length) {
    box.innerHTML = `<div class="empty" style="grid-column:1/-1">没有符合条件的岗位。<br/>试试清空关键词 / 放宽筛选，或点右上角「同步最新岗位」。</div>`;
  } else if (append) {
    box.insertAdjacentHTML("beforeend", S.items.slice(S.items.length - currentBatchSize).map(jobCard).join(""));
  } else {
    box.innerHTML = S.items.map(jobCard).join("");
  }
  $("#btnMore").classList.toggle("hide", S.items.length >= S.total);
  $("#btnMore").textContent = `加载更多岗位（已显示 ${fmtNum(S.items.length)} / ${fmtNum(S.total)}）`;
}
let currentBatchSize = 0;
function renderSummary() {
  const s = S.status;
  const bt = s.summary.byType || {};
  const campusCount = bt["国内校招岗位"] || bt.campus || 0;
  $("#viewAllNum").textContent = " " + fmtNum(s.jobCount);
  $("#viewCampusNum").textContent = " " + fmtNum(campusCount);
  $("#summary").innerHTML = `
    <span>库中真实岗位 <b>${fmtNum(s.jobCount)}</b> 条</span>
    <span class="muted">|</span><span>当前筛选命中 <b>${fmtNum(S.total)}</b> 条</span>
    ${S.hasProfile ? `<span class="badge grad">已按「${esc(S.profile.degree || "简历")}」画像排序</span>` : `<span class="badge">未上传简历 · 按应届友好度排序</span>`}
    <span class="muted">|</span><span class="small muted">国内校招岗位 ${fmtNum(campusCount)} 条 · 公开薪资 ${fmtNum(s.summary.withSalary)} 条 · 应届友好 ${fmtNum(s.summary.newGrad)} 条</span>
    <button class="btn sm ghost src" id="btnSrcInline">查看数据来源 ↗</button>`;
  $("#btnSrcInline").onclick = openSources;
}

/* ---------------- 拉取匹配 ---------------- */
async function loadJobs(reset = true) {
  if (S.busy) return;
  S.busy = true;
  if (reset) { S.offset = 0; }
  const limit = reset ? 18 : 18;
  try {
    const r = await api("/api/match", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload(limit, reset ? 0 : S.items.length)) });
    S.total = r.total;
    currentBatchSize = r.items.length;
    S.items = reset ? r.items : S.items.concat(r.items);
    renderJobs(!reset); renderSummary();
  } catch (e) {
    $("#alertBox").innerHTML = `<div class="notice warn">岗位加载失败：${esc(e.message)}</div>`;
  } finally { S.busy = false; }
}

/* ---------------- 画像渲染与编辑 ---------------- */
function tagRow(label, key, cls = "") {
  const vals = S.profile[key] || [];
  return `<div class="field"><label>${label}</label>
    <div class="taglist">${vals.length ? vals.map((v, i) => `<span class="tag ${cls}">${esc(v)}<span class="x" data-del="${key}:${i}">✕</span></span>`).join("") : `<span class="tiny muted">未识别，可手动添加</span>`}</div>
    <div class="taginput"><input data-add="${key}" placeholder="输入后回车添加" /><button class="btn sm" data-addbtn="${key}">添加</button></div>
  </div>`;
}
function renderProfile() {
  if (!S.hasProfile) return;
  const p = S.profile;
  $("#tipEngine").textContent = p.engine || "已解析";
  $("#profileBox").innerHTML = `
    <div class="field"><label>最高学历</label>
      <select id="pfDegree">${["", "大专", "本科", "硕士", "博士"].map(d => `<option value="${d}" ${p.degree === d ? "selected" : ""}>${d || "未识别 / 不限"}</option>`).join("")}</select></div>
    ${tagRow("专业", "majors", "gray")}
    ${tagRow("技能", "skills")}
    ${tagRow("意向城市", "cities", "gray")}
    ${tagRow("意向职类", "categories")}
    <div class="field"><label>期望岗位</label><input id="pfRole" value="${esc((p.expectedRoles || [])[0] || "")}" placeholder="如：后端开发工程师" /></div>
    <div class="field"><label>工作/实习年限</label><input id="pfExp" type="number" min="0" max="30" value="${Number(p.yearsExp) || 0}" /></div>
    <label class="chk ${p.isParty ? "on" : ""}" style="margin-bottom:8px"><input type="checkbox" id="pfParty" ${p.isParty ? "checked" : ""} />中共党员 / 预备党员</label>
    ${p.summary ? `<div class="hl"><b>定位：</b>${esc(p.summary)}</div>` : ""}
    ${(p.highlights || []).length ? `<div class="hl"><b>简历亮点：</b>${esc(p.highlights.join("；"))}</div>` : ""}
    ${(p.crossMajorSuggestions || []).length ? `<div class="hl" style="border-color:var(--blue)"><b>可迁移方向：</b>${esc(p.crossMajorSuggestions.join("；"))}</div>` : ""}`;
  $("#profileBox").querySelectorAll("[data-del]").forEach(x => x.onclick = () => {
    const [k, i] = x.dataset.del.split(":"); S.profile[k].splice(Number(i), 1); renderProfile();
  });
  const add = k => {
    const inp = $(`#profileBox [data-add="${k}"]`), v = inp.value.trim();
    if (!v) return;
    S.profile[k] = [...new Set([...(S.profile[k] || []), v])]; inp.value = ""; renderProfile();
  };
  $("#profileBox").querySelectorAll("[data-add]").forEach(inp => inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); add(inp.dataset.add); } });
  $("#profileBox").querySelectorAll("[data-addbtn]").forEach(b => b.onclick = () => add(b.dataset.addbtn));
  $("#pfDegree").onchange = e => S.profile.degree = e.target.value || null;
  $("#pfRole").onchange = e => S.profile.expectedRoles = e.target.value.trim() ? [e.target.value.trim()] : [];
  $("#pfExp").onchange = e => S.profile.yearsExp = Number(e.target.value) || 0;
  $("#pfParty").onchange = e => S.profile.isParty = e.target.checked;
}
function applyUploadResult(r) {
  S.file = r.file; S.profile = r.profile; S.hasProfile = true;
  renderProfile();
  $("#drop").classList.add("hide");
  $("#fileResult").classList.remove("hide");
  $("#fileResult").innerHTML = `<div class="filebox">
      <div class="fname">📎 ${esc(r.file.filename)}</div>
      <div class="fmeta"><span>${fmtSize(r.file.bytes)}</span><span>${esc(r.file.method)}</span><span>提取 ${fmtNum(r.file.chars)} 字</span></div>
      ${r.file.warnings.length ? `<div class="warnbox">⚠ ${r.file.warnings.map(esc).join("<br/>")}</div>` : `<div class="okbox">✓ 解析成功：${esc(r.profile.engine)}。已生成画像并重新排序岗位。</div>`}
      <button class="btn sm wide" id="btnReupload" style="margin-top:9px">重新上传 / 更换简历</button>
    </div>`;
  $("#btnReupload").onclick = () => { $("#drop").classList.remove("hide"); $("#fileResult").classList.add("hide"); $("#file").value = ""; };
  S.total = r.match.total; S.items = r.match.items; currentBatchSize = r.match.items.length;
  renderJobs(false); renderSummary();
  toast("简历解析完成，已按匹配度重新排序");
}

/* ---------------- 上传 ---------------- */
async function uploadFile(file) {
  if (!file) return;
  const okExt = /\.(pdf|docx|txt|md|markdown|csv|json|text)$/i.test(file.name);
  if (!okExt) { toast("仅支持 PDF / DOCX / TXT / MD 格式"); return; }
  if (file.size > 12 * 1024 * 1024) { toast("文件超过 12MB"); return; }
  $("#fileResult").classList.remove("hide");
  $("#fileResult").innerHTML = `<div class="notice info"><span class="spinner"></span>正在解析 ${esc(file.name)} 并匹配岗位…</div>`;
  const fd = new FormData(); fd.append("file", file);
  try {
    const r = await api("/api/upload-resume", { method: "POST", body: fd });
    applyUploadResult(r);
    if (S.status) { S.status.jobCount = r.jobCount; S.status.fetchedAt = r.fetchedAt; renderStatus(); }
  } catch (e) {
    $("#fileResult").innerHTML = `<div class="notice warn">解析失败：${esc(e.message)}<br/>可点「改用手写/粘贴文本」，或换一份含文字层的 PDF / DOCX。</div>`;
  }
}
async function uploadText(text) {
  if (text.trim().length < 10) { toast("请至少填写 10 个字"); return; }
  $("#fileResult").classList.remove("hide");
  $("#fileResult").innerHTML = `<div class="notice info"><span class="spinner"></span>正在解析文本并匹配岗位…</div>`;
  const fd = new FormData(); fd.append("text", text);
  try { applyUploadResult(await api("/api/upload-resume", { method: "POST", body: fd })); }
  catch (e) { $("#fileResult").innerHTML = `<div class="notice warn">解析失败：${esc(e.message)}</div>`; }
}

/* ---------------- 弹窗 ---------------- */
function modal(title, bodyHtml) {
  $("#modalRoot").innerHTML = `<div class="mask"><div class="modal">
    <div class="mh"><h2 title="${esc(title)}">${esc(truncate(title, 60))}</h2><button class="btn sm" id="mClose">关闭 ✕</button></div>
    <div class="mb">${bodyHtml}</div></div></div>`;
  $("#mClose").onclick = closeModal;
  $("#modalRoot .mask").onclick = e => { if (e.target.classList.contains("mask")) closeModal(); };
}
function closeModal() { $("#modalRoot").innerHTML = ""; }

async function openDetail(id) {
  modal("职位详情", '<div class="notice info"><span class="spinner"></span>正在从来源读取完整职位描述…</div>');
  try {
    const r = await api("/api/job?id=" + encodeURIComponent(id));
    const j = r.job;
    modal(j.title + " · " + j.company, `
      <div class="badges" style="margin-bottom:10px"><span class="badge src">${esc(j.sourceName)}</span>
        <span class="badge">${esc(j.location)}</span>${j.salaryText ? `<span class="badge">${esc(j.salaryText)}</span>` : ""}
        <span class="badge">${esc(ago(j.publishedAt))}</span></div>
      <pre>${esc(j.description || "该来源未提供完整的职位描述，请点下方按钮到原始页面查看。")}</pre>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        ${j.originUrl || j.sourceUrl ? `<a class="btn primary" href="${esc(j.originUrl || j.sourceUrl)}" target="_blank" rel="noopener">到原始页面查看 / 投递 ↗</a>` : ""}
        <a class="btn" href="${esc(j.sourceUrl || "#")}" target="_blank" rel="noopener">${esc(j.sourceName)}</a>
        <button class="btn interview" data-act="interview" data-id="${esc(j.id)}">🔍 查面经</button>
      </div>
      ${j.breakdown ? `<div class="score-detail" style="margin-top:14px"><b style="font-size:12px">匹配度评分明细</b><div style="margin-top:8px">${scoreBreakdownHtml(j)}</div></div>` : ""}
      <div class="src-line" style="margin-top:12px">抓取于 ${esc(fmtDate(j.fetchedAt, true))} · 数据以企业官网为准</div>`);
    $$("#modalRoot [data-act=interview]").forEach(b => b.onclick = () => {
      const item = S.items.find(x => x.id === b.dataset.id) || j;
      openInterview(item);
    });
  } catch (e) { modal("职位详情", `<div class="notice warn">读取失败：${esc(e.message)}</div>`); }
}

/* 面经检索：不抓取任何平台，只生成公开搜索入口，学生自行核验 */
function interviewLinks(j) {
  const company = String(j.company || "").trim();
  const role = String(j.title || "").split(/[、，,；;｜|]/)[0].trim().slice(0, 24);
  const q = `${company} ${role} 面经 校招`.replace(/\s+/g, " ").trim();
  const enc = encodeURIComponent(q);
  return [
    { name: "牛客网讨论", desc: "国内校招面经社区，按公司 + 岗位检索", url: `https://www.nowcoder.com/search?type=post&query=${enc}` },
    { name: "知乎经验", desc: "面试经验与面经复盘", url: `https://www.zhihu.com/search?type=content&q=${enc}` },
    { name: "Bing 全网", desc: "跨站检索，含企业官网与博客", url: `https://www.bing.com/search?q=${enc}` },
    { name: "GitHub 面经仓库", desc: "开源整理的面经与面题", url: `https://github.com/search?q=${enc}&type=repositories` }
  ];
}
function openInterview(j) {
  const links = interviewLinks(j);
  modal("查面经 · " + (j.company || "岗位"), `
    <div class="notice info">岗位：<b>${esc(j.company)} · ${esc(j.displayTitle || j.title)}</b><br/>
      以下是按「公司 + 岗位 + 面经」生成的<b>公开搜索入口</b>。本站不抓取、不存储任何面经内容，也不保证第三方信息准确性；请以企业官方流程为准。纯公益、不收费。</div>
    <div class="interview-links" style="margin-top:14px">
      ${links.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)} ↗<span>${esc(x.desc)}</span></a>`).join("")}
    </div>`);
}
function openSources() {
  const s = S.status; if (!s) return;
  const rows = (s.report || []).map(r => `<tr>
    <td><b>${esc(r.name)}</b><div class="tiny muted">${esc(r.detail || r.reason || "")}</div></td>
    <td class="${r.ok ? "chip-ok" : "chip-bad"}">${r.skipped ? "已关闭" : (r.ok ? "成功" : "失败")}</td>
    <td>${fmtNum(r.count)}</td><td>${r.elapsedMs ? (r.elapsedMs / 1000).toFixed(1) + "s" : "—"}</td>
    <td class="tiny">${esc((r.fails || []).join("；") || r.reason || "—")}</td></tr>`).join("");
  const srcs = (s.sources || []).map(x => `<tr><td>${esc(x.name)}</td><td>${x.enabled ? "启用" : "关闭"}</td>
    <td colspan="3"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a><div class="tiny muted">${esc(x.desc)}</div></td></tr>`).join("");
  modal("数据源 · 每一条都可核验", `
    <div class="notice info">当前共 <b>${fmtNum(s.jobCount)}</b> 条岗位，最近一次成功抓取：<b>${esc(fmtDate(s.fetchedAt, true))}</b>。
    岗位数据在运行时联网抓取并仅存于内存，不随部署包分发；每条均可点原始链接核验。</div>
    <h3 style="font-size:13px;margin:16px 0 8px">本次同步明细</h3>
    <table class="src"><thead><tr><th>数据源</th><th>状态</th><th>条数</th><th>耗时</th><th>说明</th></tr></thead><tbody>${rows || '<tr><td colspan="5">尚未同步</td></tr>'}</tbody></table>
    <h3 style="font-size:13px;margin:18px 0 8px">来源地址（公开、无需密钥）</h3>
    <table class="src"><thead><tr><th>名称</th><th>状态</th><th colspan="3">官方地址 / 说明</th></tr></thead><tbody>${srcs}</tbody></table>
    <div class="notice warn" style="margin-top:14px">不抓取 BOSS直聘、智联、前程无忧、国聘等明确禁止未授权程序访问的商业平台；
    当前启用 5 个公开来源（含「2027 校招专栏」），每条均可点原始链接核验；页面岗位来自只读快照 + 实时刷新，校招库以公益聚合 + 侵权即删方式展示。</div>`);
}
function openChecklist() {
  const rows = S.checklist.map((c, i) => `<tr><td>${i + 1}</td><td><b title="${esc(c.title)}">${esc(c.displayTitle || c.title)}</b><div class="tiny muted">${esc(c.company)} · ${esc(c.location)}</div></td>
    <td><a href="${esc(c.url)}" target="_blank" rel="noopener">原始链接 ↗</a></td><td><button class="btn sm" data-rm="${i}">移除</button></td></tr>`).join("");
  modal(`投递清单（${S.checklist.length}）`, S.checklist.length ? `
    <table class="src"><thead><tr><th>#</th><th>岗位</th><th>投递</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:14px;display:flex;gap:8px"><button class="btn primary" id="btnExport">⬇ 导出 CSV</button>
    <button class="btn" id="btnClear">清空清单</button></div>` :
    `<div class="empty" style="padding:34px">清单还是空的。在岗位卡片上点「＋ 加入投递」即可收集。</div>`);
  $$("#modalRoot [data-rm]").forEach(b => b.onclick = () => { S.checklist.splice(Number(b.dataset.rm), 1); saveList(); openChecklist(); });
  $("#btnExport") && ($("#btnExport").onclick = exportList);
  $("#btnClear") && ($("#btnClear").onclick = () => { S.checklist = []; saveList(); closeModal(); toast("清单已清空"); $$("[data-act=add]").forEach(b => { b.classList.remove("added"); b.textContent = "＋ 加入投递"; }); });
}
function saveList() { localStorage.setItem("caihang.checklist", JSON.stringify(S.checklist)); $("#listCount").textContent = S.checklist.length; }
function exportList() {
  const q = v => `"${String(v || "").replace(/"/g, '""')}"`;
  const csv = "\ufeff" + ["序号,岗位,公司,地点,薪资,匹配分,来源,原始链接"].join(",") + "\n" +
    S.checklist.map((c, i) => [i + 1, c.title, c.company, c.location, c.salaryText, c.score, c.sourceName, c.url].map(q).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = "才航-投递清单.csv"; a.click(); URL.revokeObjectURL(a.href); toast("已导出 CSV");
}

/* ---------------- 事件绑定 ---------------- */
function switchView(view) {
  if (S.view === view) return;
  S.view = view;
  $$("#views .view").forEach(b => b.classList.toggle("on", b.dataset.view === view));
  $("#campusTip").classList.toggle("hide", view !== "campus");
  $("#fType").value = view === "campus" ? "campus" : "";
  if (view === "campus") {
    $("#onlyNewGrad").checked = false;
    $("#onlyChina").checked = false;
    $("#chkGrad").classList.remove("on");
    $("#chkChina").classList.remove("on");
  }
  readFilters(); loadJobs(true);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function bind() {
  const drop = $("#drop"), file = $("#file");
  drop.onclick = () => file.click();
  file.onchange = e => uploadFile(e.target.files[0]);
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => uploadFile(e.dataTransfer.files[0]));
  $("#btnPaste").onclick = () => $("#pasteBox").classList.toggle("hide");
  $("#btnSample").onclick = () => { $("#pasteBox").classList.remove("hide"); $("#pasteText").value = SAMPLE; $("#pasteText").focus(); };
  $("#btnParseText").onclick = () => uploadText($("#pasteText").value);
  $("#btnRematch").onclick = () => { if (!S.hasProfile) { toast("请先上传简历或粘贴文本"); return; } loadJobs(true); toast("已按当前画像重新匹配"); };
  $("#btnSearch").onclick = () => { readFilters(); loadJobs(true); };
  $("#q").onkeydown = e => { if (e.key === "Enter") { readFilters(); loadJobs(true); } };
  $("#btnReset").onclick = () => {
    $("#q").value = ""; ["fType", "fCategory", "fSource", "fCity"].forEach(id => $("#" + id).value = "");
    $("#fSort").value = "score"; ["onlyNewGrad", "onlySalary", "onlyChina"].forEach(id => $("#" + id).checked = false);
    readFilters(); loadJobs(true);
  };
  ["fType", "fCategory", "fSource", "fCity", "fSort"].forEach(id => $("#" + id).onchange = () => { readFilters(); loadJobs(true); });
  ["onlyNewGrad", "onlySalary", "onlyChina"].forEach(id => $("#" + id).onchange = () => { readFilters(); loadJobs(true); });
  $("#btnMore").onclick = () => loadJobs(false);
  $("#btnSync").onclick = async () => {
    const b = $("#btnSync"); b.disabled = true; b.textContent = "⟳ 同步中…";
    try {
      const r = await api("/api/sync", { method: "POST" });
      if (!r.ok) toast(r.error || "同步未成功", 4200);
      else toast(`同步完成：${fmtNum(r.jobCount)} 条真实岗位`);
      S.status = await api("/api/status"); renderStatus(); loadJobs(true);
    } catch (e) { toast("同步失败：" + e.message, 4200); }
    finally { b.disabled = false; b.textContent = "⟳ 同步最新岗位"; }
  };
  $$("#views .view").forEach(b => b.onclick = () => switchView(b.dataset.view));
  $("#btnSources").onclick = openSources;
  $("#btnList").onclick = openChecklist;
  $("#jobs").addEventListener("click", e => {
    const btn = e.target.closest("[data-act]"); if (!btn) return;
    const card = btn.closest("[data-id]"); const id = card.dataset.id;
    const j = S.items.find(x => x.id === id); if (!j) return;
    if (btn.dataset.act === "detail") return openDetail(id);
    if (btn.dataset.act === "score") {
      const box = document.getElementById("sd-" + id);
      if (box) { box.classList.toggle("hide"); btn.textContent = box.classList.contains("hide") ? "📊 评分明细" : "📊 收起明细"; }
      return;
    }
    if (btn.dataset.act === "interview") return openInterview(j);
    if (btn.dataset.act === "add") {
      const i = S.checklist.findIndex(c => c.id === id);
      if (i >= 0) { S.checklist.splice(i, 1); btn.classList.remove("added"); btn.textContent = "＋ 加入投递"; toast("已从清单移除"); }
      else { S.checklist.push({ id, title: j.title, displayTitle: j.displayTitle, company: j.company, location: j.location, salaryText: j.salaryText, score: j.score, sourceName: j.sourceName, url: j.originUrl }); btn.classList.add("added"); btn.textContent = "✓ 已加入清单"; toast("已加入投递清单"); }
      saveList();
    }
  });
}

const SAMPLE = `张三｜2026届应届生｜求职意向：数据分析师
学历：本科，统计学专业（GPA 3.7/4.0）
技能：Python、SQL、Excel、Tableau、机器学习、数据分析，熟悉 A/B 测试与数据可视化
实习：2025.07-2025.10 某互联网公司 数据分析实习生，负责用户留存分析与周报自动化，用 Python 将报表产出时间从 3 小时缩短到 20 分钟
项目：基于公开数据的用户流失预测模型（scikit-learn，AUC 0.83）
英语：CET-6；中共预备党员
意向城市：上海、北京、杭州`;

/* ---------------- 启动 ---------------- */
(async function boot() {
  bind(); readFilters();
  try {
    S.status = await api("/api/status");
    renderStatus();
    if (!S.status.jobCount) {
      $("#alertBox").innerHTML = `<div class="notice warn">岗位库为空，正在后台同步公开数据源。请稍后点右上角「同步最新岗位」，或检查网络后重启服务。</div>`;
    }
    await loadJobs(true);
  } catch (e) {
    $("#dotApi").className = "dot off"; $("#txtApi").textContent = "后端未连接";
    $("#summary").innerHTML = `<span class="muted">无法连接本地服务：${esc(e.message)}</span>`;
    $("#jobs").innerHTML = `<div class="empty" style="grid-column:1/-1">
      <b>请先启动本地服务</b><br/><br/>
      在项目目录执行 <code>node server.js</code>，然后打开 <code>http://127.0.0.1:8081</code><br/>
      直接双击 index.html 无法加载真实岗位数据。</div>`;
  }
})();
