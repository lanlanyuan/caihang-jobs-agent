/* 简历文件解析：multipart 上传 → 纯文本
   - TXT / MD / CSV / JSON：直接解码（UTF-8 / UTF-16 / GBK）
   - DOCX：Node 内置 zlib 解 ZIP，读 word/document.xml（零依赖）
   - PDF：优先可选依赖 pdf-parse（npm install 后可用），否则内置流解压提取文本层
   - 图片 / 老式 .doc / 扫描件：明确报错，不伪装成解析成功
   隐私：文件只在内存中处理，不写入磁盘，不转发第三方（LLM 调用除外，且为一次性推理）。 */
import zlib from "node:zlib";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export const MAX_UPLOAD = 12 * 1024 * 1024;
const SUPPORTED = [".pdf", ".docx", ".txt", ".md", ".markdown", ".csv", ".json", ".text"];

/* ---------- multipart/form-data ---------- */
export function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/.exec(contentType || "");
  if (!m) throw new Error("请求不是 multipart/form-data（缺少 boundary）");
  const boundary = Buffer.from("--" + (m[1] || m[2]));
  const parts = [];
  let pos = buf.indexOf(boundary);
  if (pos < 0) throw new Error("multipart 数据格式错误");
  while (pos >= 0) {
    let start = pos + boundary.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;   // --boundary-- 结束
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const next = buf.indexOf(boundary, start);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    const chunk = buf.subarray(start, end);
    const sep = chunk.indexOf(Buffer.from("\r\n\r\n"));
    if (sep >= 0) {
      const head = chunk.subarray(0, sep).toString("utf8");
      const data = chunk.subarray(sep + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1] || "";
      const filename = /filename="([^"]*)"/i.exec(head)?.[1] || "";
      parts.push({ name, filename, data, head });
    }
    pos = next;
  }
  return parts;
}

/* ---------- 文本解码 ---------- */
function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString("utf16le"); }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString("utf8");
  let s = buf.toString("utf8");
  // 乱码特征：UTF-8 替换符过多 → 试 GBK
  if ((s.match(/\ufffd/g) || []).length > s.length * 0.01) {
    try { s = new TextDecoder("gbk").decode(buf); } catch { /* 保持 utf8 */ }
  }
  return s;
}

/* ---------- DOCX：手写 ZIP 中央目录解析 ---------- */
function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 DOCX/ZIP 文件");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const fnLen = buf.readUInt16LE(p + 28);
    const exLen = buf.readUInt16LE(p + 30);
    const cmLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + fnLen).toString("utf8");
    if (name === wanted) {
      const lfLen = buf.readUInt16LE(localOff + 26);
      const leLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lfLen + leLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      return method === 8 ? zlib.inflateRawSync(raw) : (method === 0 ? raw : null);
    }
    p += 46 + fnLen + exLen + cmLen;
  }
  return null;
}
function xmlEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}
export function docxToText(buf) {
  const parts = [];
  for (const f of ["word/document.xml", "word/footnotes.xml", "word/header1.xml"]) {
    const xml = unzipEntry(buf, f);
    if (!xml) continue;
    const s = xml.toString("utf8")
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<w:br\b[^>]*\/?>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    parts.push(xmlEntities(s));
  }
  if (!parts.length) throw new Error("DOCX 中未找到 word/document.xml，可能是加密或损坏文件");
  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- PDF：可选依赖优先，内置解析兜底（支持 ToUnicode CMap） ---------- */
function pdfLiteralBytes(lit) {
  const bytes = [];
  for (let i = 0; i < lit.length; i++) {
    let c = lit.charCodeAt(i) & 0xff;
    if (c === 92 && i + 1 < lit.length) {          // 反斜杠转义
      const n = lit[++i];
      if (n >= "0" && n <= "7") {
        let oct = n; let k = 0;
        while (k < 2 && i + 1 < lit.length && lit[i + 1] >= "0" && lit[i + 1] <= "7") { oct += lit[++i]; k++; }
        bytes.push(parseInt(oct, 8) & 0xff); continue;
      }
      ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[n] || "").split("").forEach(x => bytes.push(x.charCodeAt(0)));
      continue;
    }
    bytes.push(c);
  }
  return Buffer.from(bytes);
}
/* 解析 PDF 的 ToUnicode CMap：把 CID 码映射回 Unicode 字符。
   支持 beginbfchar（单码映射）与 beginbfrange（区间映射）。 */
function parseToUnicode(text) {
  const map = new Map();
  const hexToCode = h => parseInt(h.replace(/\s/g, ""), 16);
  const hexToStr = h => {
    const clean = h.replace(/\s/g, "");
    let out = "";
    for (let i = 0; i + 3 < clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
    return out;
  };
  let m;
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = bfchar.exec(text))) {
    const pairs = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let p;
    while ((p = pairs.exec(m[1]))) map.set(hexToCode(p[1]), hexToStr(p[2]));
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = bfrange.exec(text))) {
    const rows = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g;
    let r;
    while ((r = rows.exec(m[1]))) {
      const lo = hexToCode(r[1]), hi = hexToCode(r[2]);
      if (r[3] != null) { const base = hexToCode(r[3]); for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, String.fromCharCode(base + (c - lo))); }
      else if (r[4]) {
        const arr = [...r[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => hexToStr(x[1]));
        arr.forEach((v, i) => map.set(lo + i, v));
      }
    }
  }
  return map;
}
/* 从 PDF buffer 中提取所有解压后的 stream 文本（含 CMap） */
function pdfStreams(buf) {
  const out = [];
  const STREAM = Buffer.from("stream"), END = Buffer.from("endstream");
  let pos = 0, guard = 0;
  while (guard++ < 2000) {
    const s = buf.indexOf(STREAM, pos); if (s < 0) break;
    let start = s + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const e = buf.indexOf(END, start); if (e < 0) break;
    let end = e;
    if (buf[end - 1] === 0x0a) end--;
    if (buf[end - 1] === 0x0d) end--;
    pos = e + 9;
    const raw = buf.subarray(start, end);
    let data = raw;
    try { data = zlib.inflateRawSync(raw); } catch { try { data = zlib.inflateSync(raw); } catch { /* 未压缩流 */ } }
    if (data && data.length) out.push(data.toString("latin1"));
  }
  return out;
}
function builtinPdfToText(buf) {
  const streams = pdfStreams(buf);
  // 1) 汇总所有 CMap（多字体时合并映射）
  const cmap = new Map();
  for (const t of streams) {
    if (/beginbfchar|beginbfrange/.test(t)) {
      for (const [k, v] of parseToUnicode(t)) if (!cmap.has(k)) cmap.set(k, v);
    }
  }
  const decodeStr = (bytes, hex) => {
    // hex 串：每 2 字节的十六进制即 CID（2 字节宽 codespace）
    if (hex) {
      const h = bytes.toString("latin1").replace(/[^0-9A-Fa-f]/g, "");
      // 先判 ASCII：hex 里若字节大多是可打印英文，按 ASCII 解，避免把 "Python" 切成 2 字节 CID
      const rawBytes = Buffer.from(h.length % 2 === 0 ? h.match(/../g).map(x => parseInt(x, 16)) : [], 0);
      const asciiRatio = rawBytes.length ? [...rawBytes].filter(b => b >= 0x20 && b <= 0x7e).length / rawBytes.length : 0;
      if (asciiRatio > 0.85) return rawBytes.toString("latin1");
      if (h.length % 4 === 0) {
        let out = "";
        for (let i = 0; i + 3 < h.length; i += 4) {
          const code = parseInt(h.slice(i, i + 4), 16);
          out += cmap.get(code) ?? String.fromCharCode(code);
        }
        return out;
      }
      if (h.length % 2 === 0) {
        let out = "";
        for (let i = 0; i + 1 < h.length; i += 2) {
          const code = parseInt(h.slice(i, i + 2), 16);
          out += cmap.get(code) ?? String.fromCharCode(code);
        }
        return out;
      }
    }
    // Literal 串：ASCII 可打印为主时按 Latin1 还原英文；否则若有 CMap 按 2 字节 CID 解码
    const asciiCount = [...bytes].filter(b => b >= 0x20 && b <= 0x7e).length;
    if (bytes.length && asciiCount / bytes.length > 0.85) return bytes.toString("latin1");
    if (cmap.size && bytes.length % 2 === 0) {
      let out = "";
      for (let i = 0; i + 1 < bytes.length; i += 2) {
        const code = (bytes[i] << 8) | bytes[i + 1];
        out += cmap.get(code) ?? String.fromCharCode(code);
      }
      return out;
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) { const c = Buffer.from(bytes.subarray(2)); c.swap16(); return c.toString("utf16le"); }
    return bytes.toString("utf8");
  };
  // 2) 按内容流顺序提取 Tj / TJ / ' / " 文本
  const lines = [];
  for (const t of streams) {
    if (!/\b(Tj|TJ)\b/.test(t)) continue;
    // 统一处理：<hex> Tj / (lit) Tj / [<hex>(lit)...] TJ / ' / "
    const tokenRe = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\()])*)\)|\[((?:[^\]\\]|\\.)*)\]\s*TJ|\bTj\b|\bTd\b|\bTD\b|\bT\*\b|\bET\b/g;
    let m, bufLine = "";
    const flush = () => { if (bufLine.trim()) lines.push(bufLine.trim()); bufLine = ""; };
    while ((m = tokenRe.exec(t))) {
      const tok = m[0];
      if (m[1] !== undefined) { bufLine += decodeStr(Buffer.from(m[1], "latin1"), true); }
      else if (m[2] !== undefined) { bufLine += decodeStr(pdfLiteralBytes(m[2]), false); }
      else if (m[3] !== undefined) {
        const arr = m[3];
        const inner = /<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^\\()])*)\)/g;
        let im;
        while ((im = inner.exec(arr))) {
          if (im[1] !== undefined) bufLine += decodeStr(Buffer.from(im[1], "latin1"), true);
          else if (im[2] !== undefined) bufLine += decodeStr(pdfLiteralBytes(im[2]), false);
        }
      } else if (tok === "T*" || tok === "ET") flush();
    }
    flush();
  }
  return lines.join("\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}
async function pdfToText(buf) {
  // 可选增强：安装依赖后使用 pdf-parse（对中文 / 嵌入字体支持更好）
  // 必须以 CommonJS require 加载：pdf-parse@1.x 的 index.js 在 ESM 直接 import 时会误入调试分支读测试文件
  try {
    const fn = require("pdf-parse");
    const r = await fn(buf);
    if (r && r.text && r.text.trim().length > 20) return { text: r.text, method: "pdf-parse（中文支持）" };
  } catch { /* 未安装或解析失败 → 内置兜底 */ }
  const text = builtinPdfToText(buf);
  return { text, method: "内置 PDF 文本层提取（ToUnicode CMap）" };
}
export async function extractResume(part) {
  const filename = path.basename((part.filename || "resume.txt").replace(/\\/g, "/"));
  const ext = path.extname(filename).toLowerCase();
  const warnings = [];
  if (!SUPPORTED.includes(ext)) {
    throw new Error(`暂不支持 .${ext || "?"} 格式。请上传 PDF / DOCX / TXT / MD；扫描件与图片简历请先转成可复制文字的 PDF，或直接粘贴文本。`);
  }
  if (!part.data || !part.data.length) throw new Error("文件内容为空");
  let text = "", method = "";
  if (ext === ".docx") {
    text = docxToText(part.data); method = "DOCX (内置 ZIP/XML 解析)";
  } else if (ext === ".pdf") {
    const r = await pdfToText(part.data); text = r.text; method = r.method;
    if (text.replace(/\s/g, "").length < 30) {
      warnings.push("PDF 未提取到有效文字：可能是扫描图片或使用了嵌入字体。建议安装可选依赖（npm install）后重试，或另存为可复制文字的 PDF / DOCX。");
    }
  } else {
    text = decodeText(part.data); method = "纯文本";
    if (ext === ".json") { try { text = JSON.stringify(JSON.parse(text), null, 1).replace(/[{}\[\]",]/g, " "); } catch { /* 当普通文本 */ } }
  }
  text = text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const replacement = (text.match(/\ufffd/g) || []).length;
  if (replacement > 20) warnings.push("文本中有较多乱码字符，可能编码识别不准；建议另存为 UTF-8 的 TXT/DOCX。");
  if (!text || text.replace(/\s/g, "").length < 20) throw new Error("未能从文件中提取到足够文字（可能是纯图片简历）。请上传含文字层的 PDF/DOCX，或直接粘贴简历文本。");
  return {
    filename, bytes: part.data.length, ext, method, text,
    chars: text.length, cjkChars: cjk, warnings,
    preview: text.slice(0, 400)
  };
}
