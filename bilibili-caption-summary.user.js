// ==UserScript==
// @name         B站字幕助手 · 实时字幕 + 逐字稿 + AI总结
// @namespace    local.bilibili.caption.summary
// @version      1.0.0
// @description  B站视频实时字幕显示、一键抓取完整逐字稿并导出 SRT/VTT/TXT/JSON、调用大模型(DeepSeek)生成核心精华总结
// @author       寇豆码
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @grant        GM_download
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      *.hdslb.com
// @connect      api.deepseek.com
// @connect      api.moonshot.cn
// @connect      dashscope.aliyuncs.com
// @connect      api.openai.com
// @connect      *
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

/**
 * B站字幕助手 —— 个人自用工具，单文件、无外部依赖。
 *
 * 三大能力：
 *   L1 实时字幕：在视频上叠加字幕层（Shadow DOM 隔离），随播放进度实时显示。
 *   L2 逐字稿  ：抓取完整字幕轨，支持复制与导出 SRT / VTT / TXT / JSON。
 *   L3 AI总结  ：调用 OpenAI 兼容接口（默认 DeepSeek）对逐字稿做 map-reduce 总结。
 *
 * 设计要点：
 *   1. 纯函数（md5 / wbiSign / 导出格式等）放在顶层作用域，可在 Node 下 require 单测；
 *      所有触碰 DOM/GM_* 的逻辑统一由 main() 触发，并做环境守卫。
 *   2. WBI 签名内联自实现 MD5（不依赖 CDN / crypto.subtle）。
 *   3. 所有网络请求统一走 request() 封装（GM_xmlhttpRequest，跨域 + 带 Cookie）。
 */
(function () {
  'use strict';

  // ===== 0. 运行环境与页面全局变量兼容 =====
  // 现代 Tampermonkey 沙箱下需通过 unsafeWindow 访问页面全局变量；Node 下两者皆无。
  const W = (typeof unsafeWindow !== 'undefined')
    ? unsafeWindow
    : (typeof window !== 'undefined' ? window : {});

  // ===== 1. 通用工具函数（纯函数 · 无副作用 · 可测试） =====

  /**
   * 将字符串按 UTF-8 编码为字节数组（正确处理代理对）。
   * @param {string} str 输入字符串
   * @returns {number[]} 字节数组（0-255）
   */
  function utf8Bytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        // 高代理项：与后续低代理项合成一个码点，编码为 4 字节
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }

  /**
   * 将 32 位整数按小端输出为 8 位十六进制字符串。
   * @param {number} n 32 位有符号整数
   * @returns {string}
   */
  function toHexLE(n) {
    let out = '';
    for (let i = 0; i < 4; i++) {
      const b = (n >>> (i * 8)) & 0xff;
      out += ('0' + b.toString(16)).slice(-2);
    }
    return out;
  }

  /**
   * 对字节数组计算 MD5，返回小写 32 位十六进制。
   * @param {number[]} bytes 字节数组
   * @returns {string}
   */
  function md5Bytes(bytes) {
    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const K = new Array(64);
    for (let i = 0; i < 64; i++) {
      K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }

    const origLen = bytes.length;
    const msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    // 附加原始比特长度（小端 64 位；低位在前）
    const bitLenLo = (origLen * 8) >>> 0;
    const bitLenHi = Math.floor(origLen / 536870912) >>> 0;
    for (let i = 0; i < 4; i++) msg.push((bitLenLo >>> (i * 8)) & 0xff);
    for (let i = 0; i < 4; i++) msg.push((bitLenHi >>> (i * 8)) & 0xff);

    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let chunk = 0; chunk < msg.length; chunk += 64) {
      const M = new Array(16);
      for (let i = 0; i < 16; i++) {
        M[i] =
          msg[chunk + i * 4] |
          (msg[chunk + i * 4 + 1] << 8) |
          (msg[chunk + i * 4 + 2] << 16) |
          (msg[chunk + i * 4 + 3] << 24);
      }
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) % 16;
        }
        F = (F + A + K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
  }

  /**
   * 计算字符串的 MD5（UTF-8 编码）。
   * @param {*} input 任意输入（内部转字符串）
   * @returns {string} 小写 32 位十六进制
   */
  function md5(input) {
    return md5Bytes(utf8Bytes(String(input)));
  }

  // WBI 混淆表（B站固定常量）
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];

  /**
   * 由 imgKey + subKey 计算 mixinKey。
   * @param {string} orig imgKey + subKey 拼接结果（长度 64）
   * @returns {string} 32 位混淆后的密钥
   */
  function getMixinKey(orig) {
    return MIXIN_KEY_ENC_TAB.map((i) => orig[i]).join('').slice(0, 32);
  }

  /**
   * 将参数对象拼装为 query 字符串（按 key 字典序、过滤字符、URI 编码）。
   * @param {Object} params 参数对象
   * @returns {string}
   */
  function toQuery(params) {
    return Object.keys(params)
      .sort()
      .map((k) => {
        const v = String(params[k]).replace(/[!'()*]/g, '');
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
      })
      .join('&');
  }

  /**
   * 对参数进行 WBI 签名。
   * @param {Object} params 业务参数
   * @param {string} imgKey nav 接口返回的 img_key
   * @param {string} subKey nav 接口返回的 sub_key
   * @returns {Object} { ...params, wts, w_rid }
   */
  function wbiSign(params, imgKey, subKey) {
    const mixinKey = getMixinKey(String(imgKey || '') + String(subKey || ''));
    const wts = Math.round(Date.now() / 1000);
    const signed = Object.assign({}, params, { wts: wts });
    const query = toQuery(signed);
    signed.w_rid = md5(query + mixinKey);
    return signed;
  }

  /**
   * 将秒数格式化为时间戳。
   * @param {number} seconds 秒
   * @param {{ms?: boolean, sep?: string}} [options] ms 默认 true；sep 默认 ','
   * @returns {string} HH:MM:SS[,|.]mmm
   */
  function formatTs(seconds, options) {
    const opts = options || {};
    const useMs = opts.ms !== false;
    const sep = typeof opts.sep === 'string' ? opts.sep : ',';
    let total = Number(seconds);
    if (!isFinite(total) || total < 0) total = 0;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    const ms = Math.round((total - Math.floor(total)) * 1000);
    const pad = (n, w) => String(n).padStart(w, '0');
    let out = pad(h, 2) + ':' + pad(m, 2) + ':' + pad(s, 2);
    if (useMs) out += sep + pad(Math.min(999, ms), 3);
    return out;
  }

  /**
   * 生成 SRT 文本。
   * @param {Array<{start:number,end:number,text:string}>} cues 字幕数组
   * @returns {string}
   */
  function toSRT(cues) {
    const list = Array.isArray(cues) ? cues : [];
    if (list.length === 0) return '';
    const blocks = list.map((c, i) => {
      const start = formatTs(c.start, { ms: true, sep: ',' });
      const end = formatTs(c.end, { ms: true, sep: ',' });
      return (i + 1) + '\r\n' + start + ' --> ' + end + '\r\n' + String(c.text == null ? '' : c.text);
    });
    return blocks.join('\r\n\r\n') + '\r\n';
  }

  /**
   * 生成 WebVTT 文本。
   * @param {Array<{start:number,end:number,text:string}>} cues 字幕数组
   * @returns {string}
   */
  function toVTT(cues) {
    const list = Array.isArray(cues) ? cues : [];
    const header = 'WEBVTT\n\n';
    if (list.length === 0) return header;
    const blocks = list.map((c) => {
      const start = formatTs(c.start, { ms: true, sep: '.' });
      const end = formatTs(c.end, { ms: true, sep: '.' });
      return start + ' --> ' + end + '\n' + String(c.text == null ? '' : c.text);
    });
    return header + blocks.join('\n\n') + '\n';
  }

  /**
   * 生成纯文本逐字稿。
   * @param {Array<{start:number,end:number,text:string}>} cues 字幕数组
   * @param {boolean} [withTimestamp] 是否带时间戳
   * @returns {string}
   */
  function toTXT(cues, withTimestamp) {
    const list = Array.isArray(cues) ? cues : [];
    if (withTimestamp) {
      return list.map((c) => '[' + formatTs(c.start, { ms: false }) + '] ' + String(c.text == null ? '' : c.text)).join('\n');
    }
    return list.map((c) => String(c.text == null ? '' : c.text)).join('\n');
  }

  /**
   * 生成 JSON 文本。
   * @param {Array} cues 字幕数组
   * @returns {string}
   */
  function toJSONText(cues) {
    return JSON.stringify(Array.isArray(cues) ? cues : [], null, 2);
  }

  /**
   * 二分查找当前播放时间命中的字幕下标。
   * @param {Array<{start:number,end:number,text:string}>} cues 按 start 升序
   * @param {number} currentTime 当前播放秒
   * @returns {number} 命中的下标，未命中返回 -1
   */
  function findCueIndexAt(cues, currentTime) {
    const list = Array.isArray(cues) ? cues : [];
    const t = Number(currentTime);
    if (!isFinite(t) || list.length === 0) return -1;
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = Number(list[mid].start);
      if (isFinite(start) && start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans === -1) return -1;
    const end = Number(list[ans].end);
    // 允许 10ms 容差，减少边界抖动
    if (!isFinite(end) || t <= end + 0.01) return ans;
    return -1;
  }

  /**
   * 将逐字稿按最大字符数切分为若干块（在字幕条目边界处切分，避免切断句子）。
   * @param {Array<{start:number,end:number,text:string}>} cues 字幕数组
   * @param {number} [maxChars] 每块最大字符数，默认 6000
   * @returns {string[]} 若干文本块（每行含 [时间戳] 前缀）
   */
  function chunkTranscript(cues, maxChars) {
    const limit = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 6000;
    const list = Array.isArray(cues) ? cues : [];
    const chunks = [];
    let buf = '';
    for (let i = 0; i < list.length; i++) {
      const cue = list[i] || {};
      const entry = '[' + formatTs(cue.start, { ms: false }) + '] ' + String(cue.text == null ? '' : cue.text);
      if (buf.length > 0 && buf.length + entry.length + 1 > limit) {
        chunks.push(buf.trim());
        buf = '';
      }
      buf += (buf ? '\n' : '') + entry;
    }
    if (buf.trim()) chunks.push(buf.trim());
    return chunks;
  }

  // 默认系统提示词与总结结构模板
  const SYSTEM_PROMPT =
    '你是一名专业的中文视频内容分析助手。你会阅读视频逐字稿并输出准确、精炼、结构化的总结。' +
    '请使用简体中文和 Markdown 格式，不要编造逐字稿中不存在的信息。' +
    '注意：你只能看到逐字稿文字，看不到视频画面；若逐字稿提到「如图所示」「这个 PPT」「这条公式」等，只整理讲师口述的内容，不要臆测或补全画面里可能出现的内容。';

  const DEFAULT_TEMPLATE =
    '请阅读以下视频逐字稿（每行开头为 [时间戳]），并输出一份结构化的中文总结，必须严格使用如下 Markdown 结构：\n\n' +
    '## 一句话概括\n（用一句话概括视频核心）\n\n' +
    '## 核心观点\n（3-5 条，每条一行，以 - 开头）\n\n' +
    '## 内容脉络\n（按时间或主题分段，尽量附 [时间戳]）\n\n' +
    '## 关键结论与行动项\n（要点列出）\n\n' +
    '## 金句摘录\n（3 条，尽量附 [时间戳]）\n\n' +
    '逐字稿如下：\n\n{{transcript}}';

  // 章节化笔记模式的系统提示词与用户提示词模板
  const CHAPTER_SYSTEM_PROMPT =
    '你是一名严谨的中文课程笔记整理助手，擅长把网课逐字稿整理成结构化的章节笔记。' +
    '要求：1. 使用简体中文与 Markdown 格式；' +
    '2. 严格忠于逐字稿，不编造未出现的信息；' +
    '3. 笔记按「章 → 节 → 知识点 → 要点」分层，层级清楚；' +
    '4. 能识别讲师的章节切换信号（如「接下来我们看…」「第二个部分」「总结一下」）来划分章节；' +
    '5. 每个知识点尽量保留对应的 [时间戳]；' +
    '6. 你只能读取逐字稿文字，看不到视频画面——本工具不具备画面识别能力；若讲师提到「如图所示」「看这个 PPT」「这里的公式」，只记录其口述内容，不要臆测或补全画面里可能出现的内容。';

  // 章节化笔记的固定 Markdown 骨架（用户提示词模板，含 {{title}} / {{transcript}} 占位符）
  const CHAPTER_TEMPLATE =
    '# {{title}}\n\n' +
    '## 一句话总览\n（用 1-2 句话概括本课讲什么、学完能掌握什么）\n\n' +
    '## 章节笔记\n' +
    '### 第 1 章 · 章节标题（mm:ss）\n' +
    '- **知识点标题**：要点说明\n' +
    '- **知识点标题**：要点说明\n\n' +
    '### 第 2 章 · 章节标题（mm:ss）\n（同上）\n\n' +
    '## 关键概念速览\n' +
    '| 概念 | 说明 |\n| --- | --- |\n| xxx | xxx |\n\n' +
    '## 复习清单\n' +
    '- [ ] 需要掌握的点 1\n' +
    '- [ ] 需要掌握的点 2';

  /**
   * 构建「章节化笔记」模式发给大模型的提示词（含系统提示词与用户提示词）。
   * @param {Array<{start:number,end:number,text:string}>} cues 字幕条目（或已拼接的文本块字符串）
   * @param {{title?:string, index?:number, total?:number}} [meta] 视频元信息
   * @param {{mode?:'chapter'|'chapterMerge', template?:string, text?:string}} [opts] 可选控制项
   * @returns {{system:string, user:string}} 系统提示词与用户提示词
   */
  function buildCourseNotePrompt(cues, meta, opts) {
    const m = meta || {};
    const o = opts || {};
    const title = m.title ? String(m.title) : '';
    // 允许直接传入纯文本块（长视频 map 阶段使用）；否则由 cues 拼装带时间戳的逐字稿
    let transcript;
    if (typeof o.text === 'string') {
      transcript = o.text;
    } else {
      const list = Array.isArray(cues) ? cues : [];
      transcript = list
        .map((c) => '[' + formatTs(c.start, { ms: false }) + '] ' + String(c && c.text == null ? '' : c.text))
        .join('\n');
    }

    const titleLine = title ? '课程标题：' + title + '\n\n' : '';
    const partLine =
      (o.mode === 'chapterMerge')
        ? ''
        : (typeof m.total === 'number' && m.total > 1
            ? '（这是第 ' + (m.index || 1) + '/' + m.total + ' 部分，请只整理本部分内容）\n\n'
            : '');

    const tpl = typeof o.template === 'string' && o.template.indexOf('{{transcript}}') >= 0
      ? o.template
      : CHAPTER_TEMPLATE;

    const user = titleLine +
      partLine +
      '请阅读以下网课逐字稿（每行开头为 [时间戳]），整理成**章节化笔记**，必须严格使用如下 Markdown 结构：\n\n' +
      tpl
        .replace(/\{\{transcript\}\}/g, '')
        .replace(/\{\{title\}\}/g, title)
        .replace(/\n+$/, '') +
      '\n\n规则：\n' +
      '- 章节标题请自行归纳，不要照抄口语；\n' +
      '- 每章至少 2 个知识点，知识点用要点列表展开；\n' +
      '- 无法确定时间戳时留空，不要编造。\n\n' +
      '逐字稿如下：\n\n' + transcript;

    return { system: CHAPTER_SYSTEM_PROMPT, user: user };
  }

  /**
   * 构建「章节化笔记」分段归并（reduce）提示词。
   * @param {string[]|string} partialNotes 各段的局部章节笔记（字符串数组或已拼接文本）
   * @param {{title?:string}} [meta] 视频元信息
   * @returns {{system:string, user:string}} 系统提示词与用户提示词
   */
  function buildCourseNoteReducePrompt(partialNotes, meta) {
    const m = meta || {};
    const title = m.title ? String(m.title) : '';
    const text = Array.isArray(partialNotes)
      ? partialNotes.join('\n\n---\n\n')
      : String(partialNotes == null ? '' : partialNotes);

    const user =
      (title ? '课程标题：' + title + '\n\n' : '') +
      '下面是同一门课程各部分的局部章节笔记。请把它们合并、去重，并按时间顺序重排为**一份完整、连贯的章节笔记**，' +
      '必须严格使用如下 Markdown 结构：\n\n' +
      '# ' + title + '\n\n' +
      '## 一句话总览\n\n' +
      '## 章节笔记\n' +
      '### 第 1 章 · 章节标题（mm:ss）\n' +
      '- **知识点标题**：要点说明\n\n' +
      '## 关键概念速览\n' +
      '| 概念 | 说明 |\n| --- | --- |\n\n' +
      '## 复习清单\n' +
      '- [ ] 需要掌握的点\n\n' +
      '归并规则：\n' +
      '1. 若上一段末尾章节标记为「（未完）」且下一段开头时间连续，判定为同一章，内容追加合并，不新建章节；\n' +
      '2. 同一章在不同段出现不同标题时，以首个出现的标题为准，其余内容并入该章；\n' +
      '3. 各章按首条时间戳升序排列并重新编号；\n' +
      '4. 「关键概念速览」与「复习清单」为全局汇总，只在此步生成一次，避免重复。\n\n' +
      '各部分局部笔记如下：\n\n' + text;

    return { system: CHAPTER_SYSTEM_PROMPT, user: user };
  }

  /**
   * 将 LLM 返回的章节笔记正文装配为完整 Markdown（补齐标题头，防止模型漏掉一级标题）。
   * 纯后处理，不解析 LLM 之外的输入。
   * @param {string} noteText LLM 返回的章节笔记文本
   * @param {{title?:string}} [meta] 视频元信息
   * @returns {string} 完整 Markdown 文本
   */
  function buildCourseNoteMarkdown(noteText, meta) {
    const m = meta || {};
    const title = m.title ? String(m.title) : '';
    const body = String(noteText == null ? '' : noteText);
    // 若模型已自行输出一级标题（以 # 开头），直接返回，避免重复标题
    if (/^\s*#\s+/.test(body)) return body;
    const head = title ? '# ' + title + '\n\n' : '';
    return head + body;
  }

  /**
   * 构建发给大模型的用户提示词（user prompt）。
   * @param {string} transcript 逐字稿或要点文本
   * @param {{mode?: 'detail'|'merge'|'final', title?: string, template?: string, index?: number, total?: number}} [options]
   * @returns {string} 用户提示词字符串
   */
  function buildSummaryPrompt(transcript, options) {
    const opts = options || {};
    const mode = opts.mode || 'final';
    const text = String(transcript == null ? '' : transcript);
    const titleLine = opts.title ? '视频标题：' + opts.title + '\n' : '';

    if (mode === 'detail') {
      return (
        titleLine +
        '下面是视频第 ' + (opts.index || 1) + '/' + (opts.total || 1) +
        ' 部分的逐字稿（每行开头为 [时间戳]）。请提炼该部分的要点，用简洁的中文项目符号（- 开头）列出，' +
        '尽量保留关键信息与 [时间戳]：\n\n' + text
      );
    }
    if (mode === 'merge') {
      return (
        titleLine +
        '下面是一个视频各个部分的要点汇总。请综合这些要点，输出一份结构化的中文总结，' +
        '必须严格使用如下 Markdown 结构：\n\n' +
        '## 一句话概括\n## 核心观点\n## 内容脉络\n## 关键结论与行动项\n## 金句摘录\n\n' +
        '各部分要点如下：\n\n' + text
      );
    }
    // final：若用户自定义了模板（含占位符）则优先使用
    if (typeof opts.template === 'string' && opts.template.indexOf('{{transcript}}') >= 0) {
      return titleLine +
        opts.template
          .replace(/\{\{transcript\}\}/g, text)
          .replace(/\{\{title\}\}/g, opts.title || '');
    }
    return (
      titleLine +
      '请阅读以下视频逐字稿（每行开头为 [时间戳]），并输出一份结构化的中文总结，必须严格使用如下 Markdown 结构：\n\n' +
      '## 一句话概括\n（用一句话概括视频核心）\n\n' +
      '## 核心观点\n（3-5 条，每条一行，以 - 开头）\n\n' +
      '## 内容脉络\n（按时间或主题分段，尽量附 [时间戳]）\n\n' +
      '## 关键结论与行动项\n（要点列出）\n\n' +
      '## 金句摘录\n（3 条，尽量附 [时间戳]）\n\n' +
      '逐字稿如下：\n\n' + text
    );
  }

  /**
   * 解析 B站字幕 JSON 的 body 部分。
   * @param {string|Object} data 字幕 JSON（字符串或已解析对象）
   * @returns {Array<{start:number,end:number,text:string}>}
   */
  function parseSubtitleBody(data) {
    let obj = data;
    if (typeof obj === 'string') {
      try {
        obj = JSON.parse(obj);
      } catch (e) {
        return [];
      }
    }
    if (!obj || typeof obj !== 'object') return [];
    const body = Array.isArray(obj.body) ? obj.body : [];
    const cues = [];
    for (let i = 0; i < body.length; i++) {
      const item = body[i] || {};
      const start = Number(item.from);
      const end = Number(item.to);
      if (!isFinite(start)) continue; // from 缺失或非法则跳过该条
      cues.push({
        start: start,
        end: isFinite(end) ? end : start,
        text: typeof item.content === 'string' ? item.content : ''
      });
    }
    return cues;
  }

  // ===== 2. 默认设置与状态 =====

  const SETTINGS_KEY = 'bcs_settings_v1';
  const WBI_CACHE_KEY = 'bcs_wbi_cache_v1';

  const DEFAULT_SETTINGS = {
    subtitleEnabled: true,      // 实时字幕开关
    fontSize: 20,               // 字幕字号 12-40
    bottomOffset: 80,           // 字幕距视频底部偏移
    offsetX: 0,                 // 字幕水平偏移（相对中心，px）
    panelPos: { x: -1, y: 120 },// 面板位置（x=-1 表示靠右自适应）
    panelMinimized: false,
    withTimestamp: true,        // 逐字稿是否带时间戳
    apiBase: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    promptTemplate: DEFAULT_TEMPLATE,
    autoSummary: false,
    summaryMode: 'general'     // 总结模式：'general' 通用总结 | 'chapter' 章节化笔记
  };

  const state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    bvid: '',
    cid: 0,
    epId: '',
    isBangumi: false,
    title: '',
    cues: [],
    subtitleItems: [],   // 原始字幕列表 { lan, lan_doc, subtitle_url }
    currentLang: '',
    currentCueIndex: -1,
    fetching: false,
    summaryText: '',
    ui: { host: null, shadow: null, panel: null, overlay: null, overlayEl: null, capEl: null, rafId: 0, boundVideo: null }
  };

  /**
   * 读取设置（合并默认值，兼容老版本缺失字段）。
   * @returns {Object}
   */
  function loadSettings() {
    let saved = {};
    try {
      const raw = GM_getValue(SETTINGS_KEY, '');
      if (raw) saved = JSON.parse(raw) || {};
    } catch (e) {
      saved = {};
    }
    const merged = Object.assign({}, DEFAULT_SETTINGS, saved);
    merged.panelPos = Object.assign({}, DEFAULT_SETTINGS.panelPos, saved.panelPos || {});
    state.settings = merged;
    return merged;
  }

  /**
   * 持久化设置。
   */
  function saveSettings() {
    try {
      GM_setValue(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (e) {
      // 忽略存储异常，不影响主流程
    }
  }

  /**
   * 读取当天的 WBI 密钥缓存（跨天失效）。
   * @returns {{imgKey:string, subKey:string, date:string}|null}
   */
  function loadWbiCache() {
    try {
      const raw = GM_getValue(WBI_CACHE_KEY, '');
      if (!raw) return null;
      const obj = JSON.parse(raw);
      const today = new Date().toISOString().slice(0, 10);
      if (obj && obj.date === today && obj.imgKey && obj.subKey) return obj;
    } catch (e) {
      return null;
    }
    return null;
  }

  /**
   * 写入 WBI 密钥缓存（带日期）。
   * @param {string} imgKey
   * @param {string} subKey
   */
  function saveWbiCache(imgKey, subKey) {
    try {
      GM_setValue(
        WBI_CACHE_KEY,
        JSON.stringify({ imgKey: imgKey, subKey: subKey, date: new Date().toISOString().slice(0, 10) })
      );
    } catch (e) {
      // 忽略
    }
  }

  // ===== 3. 网络请求封装 =====

  /**
   * 统一网络请求（基于 GM_xmlhttpRequest）。
   * @param {{url:string, method?:string, headers?:Object, data?:string, timeout?:number, withCredentials?:boolean}} opts
   * @returns {Promise<{status:number, responseText:string, responseHeaders:string}>}
   */
  function request(opts) {
    const cfg = Object.assign(
      { method: 'GET', headers: {}, timeout: 30000, withCredentials: true, data: undefined },
      opts
    );
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: cfg.method,
        url: cfg.url,
        headers: cfg.headers,
        data: cfg.data,
        timeout: cfg.timeout,
        withCredentials: cfg.withCredentials,
        onload: (res) => resolve({ status: res.status, responseText: res.responseText, responseHeaders: res.responseHeaders || '' }),
        ontimeout: () => reject(new Error('REQUEST_TIMEOUT')),
        onerror: () => reject(new Error('REQUEST_ERROR')),
        onabort: () => reject(new Error('REQUEST_ABORT'))
      });
    });
  }

  /**
   * 安全解析 JSON。
   * @param {string} text
   * @returns {Object}
   */
  function safeJson(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return {};
    }
  }

  // ===== 4. B站接口与元信息 =====

  /**
   * 获取 WBI 签名密钥（内存 + GM 缓存）。
   * @returns {Promise<{imgKey:string, subKey:string}>}
   */
  async function getWbiKeys() {
    const cached = loadWbiCache();
    if (cached) return { imgKey: cached.imgKey, subKey: cached.subKey };

    const res = await request({ url: 'https://api.bilibili.com/x/web-interface/nav', method: 'GET' });
    const json = safeJson(res.responseText);
    const wbi = json && json.data && json.data.wbi_img;
    if (!wbi || !wbi.img_url || !wbi.sub_url) {
      throw new Error('无法获取 B站签名密钥（nav 接口异常）。请确认已登录 B站并刷新页面后重试。');
    }
    const imgKey = extractKeyFromUrl(wbi.img_url);
    const subKey = extractKeyFromUrl(wbi.sub_url);
    saveWbiCache(imgKey, subKey);
    return { imgKey: imgKey, subKey: subKey };
  }

  /**
   * 从 wbi_img 的 URL 中提取 key（去掉路径与扩展名）。
   * @param {string} url
   * @returns {string}
   */
  function extractKeyFromUrl(url) {
    const file = String(url).split('/').pop() || '';
    return file.split('.')[0];
  }

  /**
   * 读取当前页面视频/番剧元信息。
   * @returns {{isBangumi:boolean, bvid:string, cid:number, epId:string, title:string, pages:Array}}
   */
  function readVideoMeta() {
    const st = W.__INITIAL_STATE__ || {};
    const isBangumi = /\/bangumi\/play\//.test(location.pathname);

    if (isBangumi) {
      const ep = st.epInfo || {};
      const epId = ep.ep_id || ep.epId || '';
      const cid = Number(ep.cid) || 0;
      return {
        isBangumi: true,
        bvid: '',
        cid: cid,
        epId: String(epId || ''),
        title: ep.share_copy || ep.title || document.title,
        pages: []
      };
    }

    const vd = st.videoData || {};
    const pages = Array.isArray(vd.pages) ? vd.pages : [];
    const pParam = getQueryParam('p');
    let pIndex = pParam ? parseInt(pParam, 10) : (typeof st.p === 'number' ? st.p : 1);
    if (!pIndex || pIndex < 1) pIndex = 1;
    let cid = Number(vd.cid) || 0;
    if (pages.length && pages[pIndex - 1] && pages[pIndex - 1].cid) cid = Number(pages[pIndex - 1].cid);
    const bvid = vd.bvid || getBvidFromUrl();
    return {
      isBangumi: false,
      bvid: bvid || '',
      cid: cid,
      epId: '',
      title: vd.title || document.title,
      pages: pages
    };
  }

  /**
   * 从 URL 取 query 参数。
   * @param {string} name
   * @returns {string}
   */
  function getQueryParam(name) {
    const m = new RegExp('[?&]' + name + '=([^&#]*)').exec(location.search || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * 从 URL 提取 bvid。
   * @returns {string}
   */
  function getBvidFromUrl() {
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(location.pathname || '');
    return m ? m[1] : '';
  }

  /**
   * 补全协议相对 URL。
   * @param {string} url
   * @returns {string}
   */
  function normalizeUrl(url) {
    const u = String(url || '');
    if (u.indexOf('//') === 0) return 'https:' + u;
    return u;
  }

  /**
   * 兜底：通过 view 接口补齐 cid / bvid（__INITIAL_STATE__ 未就绪时）。
   * @returns {Promise<boolean>}
   */
  async function ensureVideoIdentity() {
    if (state.cid && (state.bvid || state.epId)) return true;
    if (state.isBangumi) {
      // 番剧 cid 依赖 __INITIAL_STATE__，稍后重试读取
      return Boolean(state.cid);
    }
    if (!state.bvid) return false;
    try {
      const res = await request({
        url: 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(state.bvid),
        method: 'GET'
      });
      const json = safeJson(res.responseText);
      if (json && json.code === 0 && json.data) {
        const pages = Array.isArray(json.data.pages) ? json.data.pages : [];
        const pParam = getQueryParam('p');
        let pIndex = pParam ? parseInt(pParam, 10) : 1;
        if (!pIndex || pIndex < 1) pIndex = 1;
        let cid = Number(json.data.cid) || 0;
        if (pages.length && pages[pIndex - 1] && pages[pIndex - 1].cid) cid = Number(pages[pIndex - 1].cid);
        state.cid = cid;
        if (json.data.title) state.title = json.data.title;
        return Boolean(state.cid);
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  /**
   * 拉取字幕列表（优先 WBI 签名接口，失败降级为老接口）。
   * @returns {Promise<Array<{id:number|string, lan:string, lan_doc:string, subtitle_url:string, subtitle_urls?:Array}>>}
   */
  async function fetchSubtitleList() {
    const params = { cid: state.cid };
    if (state.isBangumi) {
      params.ep_id = state.epId;
    } else {
      params.bvid = state.bvid;
    }

    // ① 尝试 WBI 签名接口
    try {
      const keys = await getWbiKeys();
      const signed = wbiSign(params, keys.imgKey, keys.subKey);
      const url = 'https://api.bilibili.com/x/player/wbi/v2?' + toQuery(signed);
      const res = await request({ url: url, method: 'GET' });
      const json = safeJson(res.responseText);
      if (json && json.code === 0 && json.data) {
        return extractSubtitles(json.data);
      }
      // -352 风控校验失败 → 继续降级
    } catch (e) {
      // nav 失败或请求异常 → 继续降级
    }

    // ② 降级：不带签名的老接口
    try {
      const base = state.isBangumi
        ? 'https://api.bilibili.com/x/player/v2?ep_id=' + encodeURIComponent(state.epId) + '&cid=' + encodeURIComponent(state.cid)
        : 'https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(state.bvid) + '&cid=' + encodeURIComponent(state.cid);
      const res = await request({ url: base, method: 'GET' });
      const json = safeJson(res.responseText);
      if (json && json.code === 0 && json.data) {
        return extractSubtitles(json.data);
      }
      throw new Error((json && json.message) || ('code=' + (json && json.code)));
    } catch (e) {
      throw new Error(
        '获取字幕列表失败：' + (e && e.message ? e.message : '未知错误') +
        '。请确认已登录 B站、刷新页面后重试；若仍失败可能是风控限制，稍等片刻再试。'
      );
    }
  }

  /**
   * 从 player 接口返回的 data 中提取字幕列表。
   * @param {Object} data
   * @returns {Array}
   */
  function extractSubtitles(data) {
    const sub = data && data.subtitle;
    const list = sub && Array.isArray(sub.subtitles) ? sub.subtitles : [];
    return list
      .filter((it) => it && (it.subtitle_url || (it.subtitle_urls && it.subtitle_urls.length)))
      .map((it) => ({
        id: it.id,
        lan: it.lan,
        lan_doc: it.lan_doc || it.lan,
        subtitle_url: normalizeUrl(it.subtitle_url),
        subtitle_urls: it.subtitle_urls
      }));
  }

  /**
   * 下载并解析指定字幕轨。
   * @param {{subtitle_url:string, subtitle_urls?:Array, lan_doc:string}} item
   * @returns {Promise<Array<{start:number,end:number,text:string}>>}
   */
  async function fetchSubtitleCues(item) {
    if (!item || !item.subtitle_url) {
      throw new Error('该字幕轨不是标准 JSON 格式（可能为 protobuf），暂不支持。');
    }
    const res = await request({ url: item.subtitle_url, method: 'GET', withCredentials: false });
    const cues = parseSubtitleBody(res.responseText);
    return cues;
  }

  // ===== 5. DOM 工具 =====

  /**
   * 当前播放的 video 元素。
   * @returns {HTMLVideoElement|null}
   */
  function getVideo() {
    const vids = document.querySelectorAll('video');
    for (let i = 0; i < vids.length; i++) {
      if (vids[i].duration && vids[i].duration > 0) return vids[i];
    }
    return vids.length ? vids[0] : null;
  }

  /**
   * 读取设置面板中某个输入框的当前值，并统一裁剪首尾空白。
   *
   * 「保存设置」与「测试连接」必须共用此函数，保证两处取值口径完全一致，
   * 避免历史 bug 复现：一旦某处忘记 trim，就会读到粘贴 API Key 时混入的
   * 不可见空格/换行（脏值），出现「测试连接报 401、保存后却能用」的怪现象。
   * @param {string} name 输入框的 data-role（如 'api-key' / 'api-base' / 'model'）
   * @returns {string} 裁剪首尾空白后的字符串；控件或面板不存在时返回 ''
   */
  function readFieldValue(name) {
    const panel = state.ui.panel;
    const el = panel ? panel.querySelector('[data-role="' + name + '"]') : null;
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  /**
   * 构造中文提示音 toast。
   * @param {string} message 文本
   * @param {number} [duration] 毫秒
   */
  function toast(message, duration) {
    if (!state.ui.shadow) return;
    const el = document.createElement('div');
    el.className = 'bcs-toast';
    el.textContent = String(message);
    state.ui.shadow.appendChild(el);
    const t = setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, duration || 2600);
    el.addEventListener('click', () => {
      clearTimeout(t);
      if (el.parentNode) el.parentNode.removeChild(el);
    });
  }

  /**
   * 复制文本到剪贴板。
   * @param {string} text
   */
  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text, 'text');
        toast('已复制到剪贴板');
        return;
      }
    } catch (e) {
      // 继续尝试 navigator
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => toast('已复制到剪贴板'), () => toast('复制失败'));
    } else {
      toast('复制失败：当前环境不支持');
    }
  }

  /**
   * 触发文件下载。
   * @param {string} filename
   * @param {string} content
   * @param {string} mime
   */
  function download(filename, content, mime) {
    try {
      const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (e) {
      try {
        if (typeof GM_download === 'function') {
          GM_download({
            url: 'data:' + (mime || 'text/plain') + ';charset=utf-8,' + encodeURIComponent(content),
            name: filename
          });
        } else {
          toast('导出失败：' + (e && e.message ? e.message : '未知错误'));
        }
      } catch (e2) {
        toast('导出失败：' + (e2 && e2.message ? e2.message : '未知错误'));
      }
    }
  }

  /**
   * 生成导出文件名。
   * @param {string} ext 扩展名（不含点）
   * @param {string} lang 语言标识
   * @returns {string}
   */
  function buildFilename(ext, lang) {
    const base = (state.bvid || state.epId || state.title || 'bilibili').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
    const langPart = (lang || 'zz').replace(/[\\/:*?"<>|\s]+/g, '_');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return base + '_' + langPart + '_' + ts + '.' + ext;
  }

  // ===== 6. UI：Shadow DOM 宿主与样式 =====

  const SHADOW_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Microsoft YaHei", "PingFang SC", sans-serif; }
    .bcs-panel {
      position: fixed; width: 360px; max-height: 78vh; z-index: 2147483000;
      background: #1f1f23; color: #e5e5e5; border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,.55); display: flex; flex-direction: column;
      border: 1px solid #333; font-size: 13px; overflow: hidden;
    }
    .bcs-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 8px 12px; background: #26262b; cursor: move; user-select: none;
      border-bottom: 1px solid #333;
    }
    .bcs-title { font-weight: 600; font-size: 13px; color: #fb7299; }
    .bcs-header-btns { display: flex; gap: 6px; }
    .bcs-icobtn {
      background: transparent; border: none; color: #bbb; cursor: pointer; font-size: 16px;
      line-height: 1; padding: 2px 6px; border-radius: 4px;
    }
    .bcs-icobtn:hover { background: #3a3a40; color: #fff; }
    .bcs-body { overflow-y: auto; padding: 10px 12px; }
    .bcs-tabs { display: flex; gap: 4px; margin-bottom: 10px; }
    .bcs-tab {
      flex: 1; padding: 6px 4px; background: #2b2b31; color: #aaa; border: none;
      border-radius: 6px; cursor: pointer; font-size: 12px;
    }
    .bcs-tab.active { background: #fb7299; color: #fff; }
    .bcs-pane { display: none; }
    .bcs-pane.active { display: block; }
    .bcs-row { margin-bottom: 10px; }
    .bcs-label { display: block; color: #999; margin-bottom: 4px; font-size: 12px; }
    .bcs-btn {
      background: #fb7299; color: #fff; border: none; border-radius: 6px;
      padding: 6px 10px; cursor: pointer; font-size: 12px; margin: 0 6px 6px 0;
    }
    .bcs-btn:hover { background: #ff85a7; }
    .bcs-btn.sec { background: #3a3a40; }
    .bcs-btn.sec:hover { background: #4a4a52; }
    .bcs-input, .bcs-select, .bcs-textarea {
      width: 100%; background: #2b2b31; color: #e5e5e5; border: 1px solid #3a3a40;
      border-radius: 6px; padding: 6px 8px; font-size: 12px; outline: none;
    }
    .bcs-textarea { resize: vertical; }
    .bcs-status { color: #888; font-size: 12px; min-height: 16px; margin-bottom: 8px; }
    .bcs-mini { font-size: 11px; color: #777; }
    .bcs-scope {
      background: #2a2118; border: 1px solid #5a4526; border-left: 3px solid #e8a33d;
      border-radius: 4px; padding: 7px 9px; margin-bottom: 8px;
      font-size: 11px; line-height: 1.55; color: #d6b276;
    }
    .bcs-scope b { color: #f0c070; }
    .bcs-pre {
      background: #16161a; border: 1px solid #333; border-radius: 6px; padding: 8px;
      white-space: pre-wrap; word-break: break-word; max-height: 320px; overflow-y: auto;
      font-family: Consolas, Monaco, monospace; font-size: 12px; color: #ddd; margin: 0 0 8px 0;
    }
    .bcs-transcript { max-height: 300px; }
    .bcs-inline { display: flex; align-items: center; gap: 6px; }
    .bcs-inline input[type=range] { flex: 1; }
    .bcs-badge { background: #3a3a40; border-radius: 4px; padding: 1px 6px; font-size: 11px; color: #9ad; }
    .bcs-kv { display: flex; align-items: center; gap: 8px; }
    .bcs-toast {
      position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
      background: #26262b; color: #fff; padding: 8px 16px; border-radius: 6px;
      z-index: 2147483500; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.5);
      border: 1px solid #444; max-width: 60vw;
    }
    .bcs-toast-action { background: #fb7299; color: #fff; border: none; border-radius: 4px; padding: 3px 8px; margin-left: 8px; cursor: pointer; font-size: 12px; }
    .bcs-caption {
      position: absolute; left: 50%; bottom: 80px; transform: translateX(-50%);
      max-width: 90%; text-align: center; color: #fff; font-size: 20px;
      line-height: 1.4; text-shadow: 0 1px 3px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9);
      padding: 4px 10px; border-radius: 4px; pointer-events: auto; cursor: move;
      background: rgba(0,0,0,.35); user-select: none;
    }
    .bcs-caption:empty { display: none; }
  `;

  /**
   * 创建/获取面板与字幕层的 Shadow DOM 宿主。
   */
  function ensureShadowHost() {
    if (state.ui.host && document.body.contains(state.ui.host)) return;

    const host = document.createElement('div');
    host.id = 'bcs-root-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    // 字幕浮层（独立 host，绑定视频矩形）
    const overlayHost = document.createElement('div');
    overlayHost.id = 'bcs-overlay-host';
    overlayHost.style.cssText = 'position:fixed;z-index:2147483000;pointer-events:none;overflow:hidden;';
    const overlayShadow = overlayHost.attachShadow({ mode: 'open' });
    const overlayStyle = document.createElement('style');
    overlayStyle.textContent = SHADOW_CSS;
    overlayShadow.appendChild(overlayStyle);
    const capEl = document.createElement('div');
    capEl.className = 'bcs-caption';
    // 注意：宿主 layer 为 pointer-events:none，字幕元素自身在 CSS 中恢复为 auto 以便拖动；
    // 未显示字幕时 :empty 规则会隐藏它，不会遮挡 B站原生控件。
    overlayShadow.appendChild(capEl);

    document.body.appendChild(host);
    document.body.appendChild(overlayHost);

    state.ui.host = host;
    state.ui.shadow = shadow;
    state.ui.panel = null;
    state.ui.overlay = overlayHost;
    state.ui.overlayShadow = overlayShadow;
    state.ui.overlayEl = capEl;
  }

  /**
   * 构建面板 DOM 并绑定事件。
   */
  function buildPanel() {
    if (state.ui.panel) return;
    ensureShadowHost();
    const shadow = state.ui.shadow;

    const panel = document.createElement('div');
    panel.className = 'bcs-panel';
    panel.innerHTML =
      '<div class="bcs-header" data-role="header">' +
      '  <span class="bcs-title">B站字幕助手</span>' +
      '  <div class="bcs-header-btns">' +
      '    <button class="bcs-icobtn" data-role="min" title="折叠/展开">—</button>' +
      '    <button class="bcs-icobtn" data-role="close" title="隐藏面板">×</button>' +
      '  </div>' +
      '</div>' +
      '<div class="bcs-body" data-role="body">' +
      '  <div class="bcs-tabs">' +
      '    <button class="bcs-tab active" data-tab="subtitle">字幕</button>' +
      '    <button class="bcs-tab" data-tab="transcript">逐字稿</button>' +
      '    <button class="bcs-tab" data-tab="summary">总结</button>' +
      '    <button class="bcs-tab" data-tab="settings">设置</button>' +
      '  </div>' +
      // —— 字幕 Tab ——
      '  <div class="bcs-pane active" data-pane="subtitle">' +
      '    <div class="bcs-row"><label class="bcs-label">字幕轨（多语言时可选）</label>' +
      '      <select class="bcs-select" data-role="lang"></select></div>' +
      '    <div class="bcs-row"><button class="bcs-btn" data-role="fetch">抓取字幕</button>' +
      '      <button class="bcs-btn sec" data-role="rt-toggle">切换实时字幕</button></div>' +
      '    <div class="bcs-status" data-role="sub-status"></div>' +
      '    <div class="bcs-row"><label class="bcs-label">字号：<span data-role="font-val">20</span> px</label>' +
      '      <div class="bcs-inline"><input type="range" min="12" max="40" step="1" data-role="font"></div></div>' +
      '    <div class="bcs-row"><label class="bcs-label">底部偏移：<span data-role="offset-val">80</span> px</label>' +
      '      <div class="bcs-inline"><input type="range" min="0" max="400" step="2" data-role="offset"></div></div>' +
      '    <div class="bcs-row"><button class="bcs-btn sec" data-role="reset-pos">重置字幕位置</button></div>' +
      '  </div>' +
      // —— 逐字稿 Tab ——
      '  <div class="bcs-pane" data-pane="transcript">' +
      '    <div class="bcs-row bcs-inline"><input type="checkbox" data-role="ts-toggle"><label class="bcs-mini">显示时间戳</label>' +
      '      <span class="bcs-badge" data-role="cue-count">0</span></div>' +
      '    <div class="bcs-pre bcs-transcript" data-role="transcript"></div>' +
      '    <div class="bcs-row">' +
      '      <button class="bcs-btn" data-role="copy-all">复制全文</button>' +
      '      <button class="bcs-btn sec" data-role="exp-srt">导出 SRT</button>' +
      '      <button class="bcs-btn sec" data-role="exp-vtt">导出 VTT</button>' +
      '      <button class="bcs-btn sec" data-role="exp-txt">导出 TXT</button>' +
      '      <button class="bcs-btn sec" data-role="exp-json">导出 JSON</button>' +
      '    </div>' +
      '  </div>' +
      // —— 总结 Tab ——
      '  <div class="bcs-pane" data-pane="summary">' +
      '    <div class="bcs-row"><label class="bcs-label">总结模式</label>' +
      '      <select class="bcs-select" data-role="sum-mode">' +
      '        <option value="general">通用总结</option>' +
      '        <option value="chapter">章节化笔记</option>' +
      '      </select></div>' +
      '    <div class="bcs-scope" data-role="scope-notice"><b>适用范围：</b>本工具只读取视频自带的<b>字幕文本</b>，不具备画面识别能力（无 OCR / 视觉理解）。仅适用于<b>访谈、讲座、纯口述讲解</b>等「画面不含实质内容」的视频；若知识点主要靠 <b>PPT / 板书 / 公式 / 图表 / 代码演示</b> 呈现，这些画面内容<b>不会被总结到</b>。无字幕轨（含仅硬字幕）的视频无法使用。</div>' +
      '    <div class="bcs-row"><button class="bcs-btn" data-role="gen">生成总结</button>' +
      '      <button class="bcs-btn sec" data-role="copy-sum">复制总结</button>' +
      '      <button class="bcs-btn sec" data-role="exp-md">导出 Markdown</button>' +
      '      <button class="bcs-btn sec" data-role="exp-img">导出图片</button></div>' +
      '    <div class="bcs-status" data-role="sum-status"></div>' +
      '    <div class="bcs-pre" data-role="summary"></div>' +
      '  </div>' +
      // —— 设置 Tab ——
      '  <div class="bcs-pane" data-pane="settings">' +
      '    <div class="bcs-row"><label class="bcs-label">一键预设</label>' +
      '      <button class="bcs-btn sec" data-preset="deepseek">DeepSeek</button>' +
      '      <button class="bcs-btn sec" data-preset="kimi">Kimi</button>' +
      '      <button class="bcs-btn sec" data-preset="qwen">通义</button>' +
      '      <button class="bcs-btn sec" data-preset="openai">OpenAI</button></div>' +
      '    <div class="bcs-row"><label class="bcs-label">API Base URL</label>' +
      '      <input class="bcs-input" data-role="api-base" placeholder="https://api.deepseek.com/v1"></div>' +
      '    <div class="bcs-row"><label class="bcs-label">API Key（仅存本地）</label>' +
      '      <div class="bcs-kv"><input class="bcs-input" type="password" data-role="api-key" placeholder="sk-...">' +
      '      <button class="bcs-btn sec" data-role="key-toggle">显示</button></div></div>' +
      '    <div class="bcs-row"><label class="bcs-label">模型</label>' +
      '      <input class="bcs-input" data-role="model" placeholder="deepseek-chat"></div>' +
      '    <div class="bcs-row"><label class="bcs-label">temperature：<span data-role="temp-val">0.3</span></label>' +
      '      <div class="bcs-inline"><input type="range" min="0" max="1" step="0.1" data-role="temp"></div></div>' +
      '    <div class="bcs-row"><label class="bcs-label">总结提示词模板</label>' +
      '      <textarea class="bcs-textarea" rows="6" data-role="prompt"></textarea>' +
      '      <button class="bcs-btn sec" data-role="reset-prompt">恢复默认</button></div>' +
      '    <div class="bcs-row bcs-inline"><input type="checkbox" data-role="auto-summary"><label class="bcs-mini">播放结束自动生成总结</label></div>' +
      '    <div class="bcs-row"><button class="bcs-btn" data-role="save-settings">保存设置</button>' +
      '      <button class="bcs-btn sec" data-role="test-conn">测试连接</button></div>' +
      '    <div class="bcs-status" data-role="test-status"></div>' +
      '  </div>' +
      '</div>';

    shadow.appendChild(panel);
    state.ui.panel = panel;
    wirePanel(panel);
    applyPanelPosition();
    syncControlsFromSettings();
    if (state.settings.panelMinimized) {
      panel.querySelector('[data-role="body"]').style.display = 'none';
    }
  }

  /**
   * 绑定面板内交互事件。
   * @param {HTMLElement} panel
   */
  function wirePanel(panel) {
    const q = (role) => panel.querySelector('[data-role="' + role + '"]');
    const qa = (role) => Array.prototype.slice.call(panel.querySelectorAll('[data-role="' + role + '"]'));

    // 折叠 / 关闭
    q('min').addEventListener('click', () => {
      const body = q('body');
      const hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      state.settings.panelMinimized = !hidden;
      saveSettings();
    });
    q('close').addEventListener('click', () => hidePanel());

    // Tab 切换
    panel.querySelectorAll('.bcs-tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')));
    });

    // 拖动面板
    makeDraggable(panel, q('header'));

    // 字幕 Tab
    q('fetch').addEventListener('click', () => doFetch(true));
    q('rt-toggle').addEventListener('click', () => {
      state.settings.subtitleEnabled = !state.settings.subtitleEnabled;
      saveSettings();
      applySubtitleVisibility();
      toast(state.settings.subtitleEnabled ? '实时字幕已开启' : '实时字幕已关闭');
    });
    q('lang').addEventListener('change', (e) => {
      state.currentLang = e.target.value;
    });
    q('font').addEventListener('input', (e) => {
      state.settings.fontSize = Number(e.target.value);
      q('font-val').textContent = String(state.settings.fontSize);
      applyCaptionStyle();
    });
    q('font').addEventListener('change', saveSettings);
    q('offset').addEventListener('input', (e) => {
      state.settings.bottomOffset = Number(e.target.value);
      q('offset-val').textContent = String(state.settings.bottomOffset);
      applyCaptionStyle();
    });
    q('offset').addEventListener('change', saveSettings);
    q('reset-pos').addEventListener('click', () => {
      state.settings.offsetX = 0;
      state.settings.bottomOffset = DEFAULT_SETTINGS.bottomOffset;
      saveSettings();
      syncControlsFromSettings();
      applyCaptionStyle();
    });

    // 逐字稿 Tab
    q('ts-toggle').addEventListener('change', (e) => {
      state.settings.withTimestamp = e.target.checked;
      saveSettings();
      renderTranscript();
    });
    q('copy-all').addEventListener('click', () => {
      if (!state.cues.length) return toast('尚未抓取字幕');
      copyText(toTXT(state.cues, state.settings.withTimestamp));
    });
    q('exp-srt').addEventListener('click', () => doExport('srt'));
    q('exp-vtt').addEventListener('click', () => doExport('vtt'));
    q('exp-txt').addEventListener('click', () => doExport('txt'));
    q('exp-json').addEventListener('click', () => doExport('json'));

    // 总结 Tab
    q('sum-mode').addEventListener('change', (e) => {
      state.settings.summaryMode = e.target.value === 'chapter' ? 'chapter' : 'general';
      saveSettings();
    });
    q('gen').addEventListener('click', () => generateSummary(state.settings.summaryMode));
    q('copy-sum').addEventListener('click', () => {
      if (!state.summaryText) return toast('还没有总结内容');
      copyText(state.summaryText);
    });
    q('exp-md').addEventListener('click', () => {
      if (!state.summaryText) return toast('还没有总结内容');
      const suffix = state.settings.summaryMode === 'chapter' ? '_笔记' : '';
      download(buildFilename('md', (state.currentLang || 'summary') + suffix), state.summaryText, 'text/markdown;charset=utf-8');
    });
    q('exp-img').addEventListener('click', () => exportNoteImage());

    // 设置 Tab
    panel.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyPreset(btn.getAttribute('data-preset')));
    });
    q('key-toggle').addEventListener('click', () => {
      const input = q('api-key');
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      q('key-toggle').textContent = hidden ? '隐藏' : '显示';
    });
    q('temp').addEventListener('input', (e) => {
      q('temp-val').textContent = e.target.value;
    });
    q('reset-prompt').addEventListener('click', () => {
      state.settings.promptTemplate = DEFAULT_TEMPLATE;
      q('prompt').value = DEFAULT_TEMPLATE;
      saveSettings();
      toast('已恢复默认提示词');
    });
    q('save-settings').addEventListener('click', () => {
      // 与「测试连接」共用 readFieldValue，确保两处取值口径一致（统一 trim）
      state.settings.apiBase = readFieldValue('api-base') || DEFAULT_SETTINGS.apiBase;
      state.settings.apiKey = readFieldValue('api-key');
      state.settings.model = readFieldValue('model') || DEFAULT_SETTINGS.model;
      state.settings.temperature = Number(q('temp').value);
      state.settings.promptTemplate = q('prompt').value || DEFAULT_TEMPLATE;
      state.settings.autoSummary = q('auto-summary').checked;
      saveSettings();
      toast('设置已保存');
    });
    q('test-conn').addEventListener('click', () => testConnection());
  }

  /**
   * 让面板可通过 header 拖动。
   * @param {HTMLElement} panel
   * @param {HTMLElement} handle
   */
  function makeDraggable(panel, handle) {
    let startX = 0;
    let startY = 0;
    let origX = 0;
    let origY = 0;
    let dragging = false;

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let x = origX + dx;
      let y = origY + dy;
      x = Math.max(0, Math.min(window.innerWidth - 80, x));
      y = Math.max(0, Math.min(window.innerHeight - 40, y));
      panel.style.left = x + 'px';
      panel.style.top = y + 'px';
      panel.style.right = 'auto';
      state.settings.panelPos = { x: x, y: y };
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      saveSettings();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    handle.addEventListener('mousedown', (e) => {
      if (e.target && e.target.getAttribute && e.target.getAttribute('data-role')) return; // 点击按钮不触发拖动
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
    });
  }

  /**
   * 应用面板位置（根据设置）。
   */
  function applyPanelPosition() {
    const panel = state.ui.panel;
    if (!panel) return;
    const pos = state.settings.panelPos || { x: -1, y: 120 };
    if (pos.x < 0) {
      panel.style.right = '20px';
      panel.style.left = 'auto';
    } else {
      panel.style.left = pos.x + 'px';
      panel.style.right = 'auto';
    }
    panel.style.top = Math.max(0, pos.y || 120) + 'px';
  }

  /**
   * 从设置同步到面板控件。
   */
  function syncControlsFromSettings() {
    const panel = state.ui.panel;
    if (!panel) return;
    const q = (role) => panel.querySelector('[data-role="' + role + '"]');
    const s = state.settings;
    q('font').value = String(s.fontSize);
    q('font-val').textContent = String(s.fontSize);
    q('offset').value = String(s.bottomOffset);
    q('offset-val').textContent = String(s.bottomOffset);
    q('ts-toggle').checked = Boolean(s.withTimestamp);
    q('api-base').value = s.apiBase || '';
    q('api-key').value = s.apiKey || '';
    q('model').value = s.model || '';
    q('temp').value = String(s.temperature);
    q('temp-val').textContent = String(s.temperature);
    q('prompt').value = s.promptTemplate || DEFAULT_TEMPLATE;
    q('auto-summary').checked = Boolean(s.autoSummary);
    if (q('sum-mode')) q('sum-mode').value = s.summaryMode === 'chapter' ? 'chapter' : 'general';
  }

  /**
   * 切换 Tab。
   * @param {string} name
   */
  function switchTab(name) {
    const panel = state.ui.panel;
    if (!panel) return;
    panel.querySelectorAll('.bcs-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-tab') === name);
    });
    panel.querySelectorAll('.bcs-pane').forEach((p) => {
      p.classList.toggle('active', p.getAttribute('data-pane') === name);
    });
  }

  /**
   * 应用 LLM 预设。
   * @param {string} name deepseek|kimi|qwen|openai
   */
  function applyPreset(name) {
    const panel = state.ui.panel;
    if (!panel) return;
    const presets = {
      deepseek: { apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      kimi: { apiBase: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
      qwen: { apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
      openai: { apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
    };
    const p = presets[name];
    if (!p) return;
    panel.querySelector('[data-role="api-base"]').value = p.apiBase;
    panel.querySelector('[data-role="model"]').value = p.model;
    state.settings.apiBase = p.apiBase;
    state.settings.model = p.model;
    saveSettings();
    toast('已切换预设：' + name);
  }

  /**
   * 显示/隐藏面板。
   */
  function showPanel() {
    buildPanel();
    ensureShadowHost();
    state.ui.panel.style.display = 'flex';
  }

  function hidePanel() {
    if (state.ui.panel) state.ui.panel.style.display = 'none';
  }

  // ===== 7. 实时字幕浮层 =====

  /**
   * 定位字幕浮层到视频矩形上。
   */
  function positionOverlay() {
    const overlay = state.ui.overlay;
    const video = getVideo();
    if (!overlay || !video) return;
    const r = video.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      overlay.style.display = 'none';
      return;
    }
    overlay.style.display = 'block';
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    applyCaptionStyle();
  }

  /**
   * 应用字幕样式（字号、偏移）。
   */
  function applyCaptionStyle() {
    const el = state.ui.overlayEl;
    if (!el) return;
    el.style.fontSize = state.settings.fontSize + 'px';
    el.style.bottom = state.settings.bottomOffset + 'px';
    el.style.transform = 'translateX(calc(-50% + ' + (state.settings.offsetX || 0) + 'px))';
  }

  /**
   * 应用实时字幕可见性。
   */
  function applySubtitleVisibility() {
    const el = state.ui.overlayEl;
    if (!el) return;
    if (!state.settings.subtitleEnabled) {
      el.textContent = '';
    }
  }

  /**
   * 根据当前播放时间刷新字幕。
   */
  function updateCaption() {
    const el = state.ui.overlayEl;
    if (!el) return;
    if (!state.settings.subtitleEnabled) {
      if (el.textContent) el.textContent = '';
      return;
    }
    const video = getVideo();
    if (!video || !state.cues.length) {
      if (el.textContent) el.textContent = '';
      return;
    }
    const idx = findCueIndexAt(state.cues, video.currentTime);
    if (idx === state.currentCueIndex) return;
    state.currentCueIndex = idx;
    const text = idx >= 0 ? String(state.cues[idx].text || '') : '';
    if (el.textContent !== text) el.textContent = text; // 使用 textContent 防 XSS
  }

  /**
   * rAF 驱动的字幕更新循环（与 timeupdate 双保险）。
   */
  function startCaptionLoop() {
    stopCaptionLoop();
    const tick = () => {
      updateCaption();
      positionOverlay();
      state.ui.rafId = requestAnimationFrame(tick);
    };
    state.ui.rafId = requestAnimationFrame(tick);
  }

  function stopCaptionLoop() {
    if (state.ui.rafId) {
      cancelAnimationFrame(state.ui.rafId);
      state.ui.rafId = 0;
    }
  }

  /**
   * 绑定 video 的 ended 事件（播放结束自动处理）。
   * @param {HTMLVideoElement} video
   */
  function bindVideoEvents(video) {
    if (!video || state.ui.boundVideo === video) return;
    state.ui.boundVideo = video;
    video.addEventListener('timeupdate', updateCaption);
    video.addEventListener('ended', onVideoEnded);
  }

  /**
   * 播放结束回调。
   */
  function onVideoEnded() {
    if (!state.cues.length) return;
    toastAction('播放结束，逐字稿已就绪', [
      { text: '查看逐字稿', fn: () => { showPanel(); switchTab('transcript'); } },
      {
        text: '生成总结',
        fn: () => {
          showPanel();
          switchTab('summary');
          generateSummary(state.settings.summaryMode);
        }
      }
    ]);
    if (state.settings.autoSummary && state.settings.apiKey) {
      showPanel();
      switchTab('summary');
      generateSummary(state.settings.summaryMode);
    }
  }

  /**
   * 带操作按钮的 toast。
   * @param {string} message
   * @param {Array<{text:string, fn:Function}>} actions
   */
  function toastAction(message, actions) {
    ensureShadowHost();
    const el = document.createElement('div');
    el.className = 'bcs-toast';
    const span = document.createElement('span');
    span.textContent = message;
    el.appendChild(span);
    (actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.className = 'bcs-toast-action';
      btn.textContent = a.text;
      btn.addEventListener('click', () => {
        a.fn();
        if (el.parentNode) el.parentNode.removeChild(el);
      });
      el.appendChild(btn);
    });
    state.ui.shadow.appendChild(el);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 8000);
  }

  // ===== 8. 抓取流程与渲染 =====

  /**
   * 执行字幕抓取。
   * @param {boolean} fromUser 是否用户主动触发
   */
  async function doFetch(fromUser) {
    if (state.fetching) return;
    if (!state.cid && !state.epId) {
      setSubStatus('尚未识别到视频信息，请稍候或刷新页面');
      return;
    }
    state.fetching = true;
    setSubStatus('字幕加载中…');
    try {
      await ensureVideoIdentity();
      const list = await fetchSubtitleList();
      if (!list.length) {
        setSubStatus('');
        toast('该视频没有可用的 CC/AI 字幕（up 主未上传或未开启 AI 字幕），本方案无法生成逐字稿。可改用通义听悟 / 本地 Whisper 方案。', 6000);
        renderLangOptions([]);
        state.cues = [];
        renderTranscript();
        return;
      }
      state.subtitleItems = list;
      renderLangOptions(list);
      // 默认选第一条（或沿用上次语言）
      let chosen = list.find((it) => it.lan === state.currentLang) || list[0];
      state.currentLang = chosen.lan;
      const langSelect = state.ui.panel ? state.ui.panel.querySelector('[data-role="lang"]') : null;
      if (langSelect) langSelect.value = chosen.lan;
      const cues = await fetchSubtitleCues(chosen);
      if (!cues.length) {
        setSubStatus('');
        toast('字幕内容为空，无法解析为逐字稿。');
        return;
      }
      state.cues = cues;
      state.currentCueIndex = -1;
      setSubStatus('已抓取 ' + cues.length + ' 条字幕（' + (chosen.lan_doc || chosen.lan) + '）');
      renderTranscript();
      if (fromUser) toast('字幕抓取完成，共 ' + cues.length + ' 条');
    } catch (e) {
      setSubStatus('');
      toast(e && e.message ? e.message : '字幕抓取失败', 6000);
    } finally {
      state.fetching = false;
    }
  }

  /**
   * 填充语言下拉。
   * @param {Array} list
   */
  function renderLangOptions(list) {
    const panel = state.ui.panel;
    if (!panel) return;
    const sel = panel.querySelector('[data-role="lang"]');
    sel.innerHTML = '';
    if (!list.length) {
      const opt = document.createElement('option');
      opt.textContent = '（无可用字幕）';
      opt.value = '';
      sel.appendChild(opt);
      return;
    }
    list.forEach((it) => {
      const opt = document.createElement('option');
      opt.value = it.lan;
      opt.textContent = it.lan_doc || it.lan;
      sel.appendChild(opt);
    });
  }

  /**
   * 渲染逐字稿。
   */
  function renderTranscript() {
    const panel = state.ui.panel;
    if (!panel) return;
    const pre = panel.querySelector('[data-role="transcript"]');
    const count = panel.querySelector('[data-role="cue-count"]');
    count.textContent = String(state.cues.length);
    if (!state.cues.length) {
      pre.textContent = '（暂无逐字稿，请到「字幕」标签点击“抓取字幕”）';
      return;
    }
    pre.textContent = toTXT(state.cues, state.settings.withTimestamp);
  }

  /**
   * 设置字幕状态文本。
   * @param {string} text
   */
  function setSubStatus(text) {
    const panel = state.ui.panel;
    if (!panel) return;
    const el = panel.querySelector('[data-role="sub-status"]');
    if (el) el.textContent = text;
  }

  /**
   * 导出指定格式。
   * @param {string} format srt|vtt|txt|json
   */
  function doExport(format) {
    if (!state.cues.length) return toast('尚未抓取字幕');
    const lang = state.currentLang || 'zz';
    if (format === 'srt') {
      download(buildFilename('srt', lang), toSRT(state.cues), 'text/plain;charset=utf-8');
    } else if (format === 'vtt') {
      download(buildFilename('vtt', lang), toVTT(state.cues), 'text/vtt;charset=utf-8');
    } else if (format === 'txt') {
      download(buildFilename('txt', lang), toTXT(state.cues, state.settings.withTimestamp), 'text/plain;charset=utf-8');
    } else if (format === 'json') {
      download(buildFilename('json', lang), toJSONText(state.cues), 'application/json;charset=utf-8');
    }
  }

  /**
   * 把当前总结渲染成一张排版长图并导出 PNG（零依赖，纯 Canvas 手绘）。
   */
  function exportNoteImage() {
    if (!state.summaryText) return toast('还没有总结内容');
    try {
      const isChapter = state.settings.summaryMode === 'chapter';
      const meta = {
        title: state.title || '学习笔记',
        subtitle: (isChapter ? 'B站网课' : 'B站视频') +
          (state.bvid ? ' · ' + state.bvid : '') + ' · 由 AI 整理',
        footer: '由 B站字幕助手 生成 · ' + (isChapter ? '章节化笔记' : '通用总结'),
        chapter: isChapter
      };
      const canvas = renderToCanvas(state.summaryText, meta, { width: 900, scale: 2 });
      canvas.toBlob((blob) => {
        if (!blob) return toast('图片生成失败');
        const filename = buildFilename('png', state.currentLang || 'note');
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          if (a.parentNode) a.parentNode.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);
        toast('图片已导出');
      }, 'image/png');
    } catch (e) {
      toast('导出图片失败：' + (e && e.message ? e.message : '未知错误'));
    }
  }

  // ===== 8.5 笔记图片渲染（纯 Canvas 手绘，零依赖） =====

  // ============ 主题 ============
  var THEME = {
    width: 900,
    scale: 2,
    pad: 56,
    bg: '#FFFFFF',
    pageBg: '#F1F5F9',
    headerFrom: '#4338CA',
    headerTo: '#6D28D9',
    headerText: '#FFFFFF',
    headerSub: '#C7D2FE',
    h2Text: '#0F172A',
    h2Bar: '#4338CA',
    h3Text: '#1E293B',
    h3Bg: '#EEF2FF',
    h3Badge: '#4338CA',
    h3BadgeText: '#FFFFFF',
    liText: '#334155',
    liDot: '#6366F1',
    liBold: '#0F172A',
    tsColor: '#D97706',
    tableHeadBg: '#EEF2FF',
    tableHeadText: '#312E81',
    tableRowAlt: '#F8FAFC',
    tableBorder: '#E2E8F0',
    tableText: '#334155',
    checkBox: '#94A3B8',
    checkText: '#334155',
    hr: '#E2E8F0',
    footer: '#94A3B8',
    quoteBar: '#C7D2FE',
    quoteText: '#475569'
  };

  var FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Segoe UI", sans-serif';

  // ============ Markdown 解析（纯函数，可单测） ============

  function splitTableRow(line) {
    var s = String(line || '').trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) { return c.trim(); });
  }

  function isTableSep(line) {
    return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(String(line || '').trim());
  }

  /**
   * 把 Markdown 文本解析成结构化块数组。
   * @param {string} md
   * @returns {Array<Object>}
   */
  function parseNoteBlocks(md) {
    var lines = String(md == null ? '' : md).split(/\r?\n/);
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i].trim();
      if (!line) { i++; continue; }

      // 表格
      if (line.charAt(0) === '|' && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var headers = splitTableRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim().charAt(0) === '|') {
          rows.push(splitTableRow(lines[i]));
          i++;
        }
        blocks.push({ type: 'table', headers: headers, rows: rows });
        continue;
      }

      // 标题
      var m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        blocks.push({ type: 'h' + m[1].length, text: m[2].trim() });
        i++;
        continue;
      }

      // 引用
      m = line.match(/^>\s?(.*)$/);
      if (m) {
        blocks.push({ type: 'quote', text: m[1].trim() });
        i++;
        continue;
      }

      // 勾选项
      m = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
      if (m) {
        blocks.push({ type: 'check', checked: m[1].toLowerCase() === 'x', text: m[2].trim() });
        i++;
        continue;
      }

      // 无序列表
      m = line.match(/^[-*+]\s+(.*)$/);
      if (m) {
        blocks.push({ type: 'li', text: m[1].trim() });
        i++;
        continue;
      }

      // 有序列表
      m = line.match(/^(\d+)[.)]\s+(.*)$/);
      if (m) {
        blocks.push({ type: 'oli', index: m[1], text: m[2].trim() });
        i++;
        continue;
      }

      // 分隔线
      if (/^([-*_])\1{2,}$/.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      // 普通段落
      blocks.push({ type: 'p', text: line });
      i++;
    }
    return blocks;
  }

  /**
   * 把含 **加粗** 的文本拆成片段。
   * @param {string} text
   * @returns {Array<{text:string,bold:boolean}>}
   */
  function parseInline(text) {
    var s = String(text == null ? '' : text);
    var parts = [];
    var re = /\*\*(.+?)\*\*/g;
    var last = 0;
    var m;
    while ((m = re.exec(s))) {
      if (m.index > last) parts.push({ text: s.slice(last, m.index), bold: false });
      parts.push({ text: m[1], bold: true });
      last = re.lastIndex;
    }
    if (last < s.length) parts.push({ text: s.slice(last), bold: false });
    if (!parts.length) parts.push({ text: s, bold: false });
    return parts;
  }

  /**
   * 把 [12:34] 形式的时间戳从文本中拆出，便于单独着色。
   * @param {string} text
   */
  function splitTimestamp(text) {
    var s = String(text == null ? '' : text);
    var m = s.match(/^(.*?)[([\uFF08\uFF3B]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[)\]\uFF09\uFF3D]\s*$/);
    if (m) return { main: m[1].trim(), ts: m[2] };
    return { main: s, ts: '' };
  }

  // ============ 绘制工具 ============

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function setFont(ctx, size, bold) {
    ctx.font = (bold ? '700 ' : '400 ') + size + 'px ' + FONT;
  }

  /**
   * 把内联片段（含加粗）按宽度切成行。
   * @returns {Array<{parts:Array,width:number}>}
   */
  function wrapInline(measureCtx, parts, maxWidth, size) {
    var lines = [];
    var curParts = [];
    var curW = 0;
    function flush() {
      if (curParts.length) lines.push({ parts: curParts, width: curW });
      curParts = [];
      curW = 0;
    }
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi];
      setFont(measureCtx, size, p.bold);
      var toks = String(p.text).match(/[A-Za-z0-9%.,:;'"()\-/+=@#]+|\s+|[\s\S]/g) || [];
      for (var ti = 0; ti < toks.length; ti++) {
        var tok = toks[ti];
        var w = measureCtx.measureText(tok).width;
        if (curW + w > maxWidth && curParts.length && !/^\s+$/.test(tok)) {
          flush();
        }
        var last = curParts[curParts.length - 1];
        if (last && last.bold === p.bold) last.text += tok;
        else curParts.push({ text: tok, bold: p.bold });
        curW += w;
      }
    }
    flush();
    if (!lines.length) lines.push({ parts: [{ text: '', bold: false }], width: 0 });
    return lines;
  }

  /** 在指定 y 起始处绘制若干行（行首对齐 x），返回结束 y */
  function drawLines(ctx, lines, x, y, size, lineHeight, color, boldColor) {
    for (var i = 0; i < lines.length; i++) {
      var cx = x;
      var parts = lines[i].parts;
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        setFont(ctx, size, p.bold);
        ctx.fillStyle = p.bold ? (boldColor || color) : color;
        ctx.fillText(p.text, cx, y + i * lineHeight);
        cx += ctx.measureText(p.text).width;
      }
    }
    return y + lines.length * lineHeight;
  }

  /**
   * 绘制单个块，返回新的 y。dry=true 时只计算高度不落笔。
   */
  function drawBlock(ctx, b, y, L, dry) {
    var T = THEME;
    var x = L.pad;
    var w = L.innerW;
    var lines, i, k;

    if (b.type === 'h2') {
      y += 36;
      lines = wrapInline(ctx, parseInline(b.text), w - 20, 22);
      if (!dry) {
        ctx.fillStyle = T.h2Bar;
        roundRect(ctx, x, y - 16, 5, 22, 2.5);
        ctx.fill();
      }
      y = dry ? y + lines.length * 32 : drawLines(ctx, lines, x + 20, y, 22, 32, T.h2Text, T.h2Text);
      return y + 14;
    }

    if (b.type === 'h3') {
      y += 26;
      var h3text = splitTimestamp(b.text);
      var h3parts = parseInline(h3text.main);
      var h3lines = wrapInline(ctx, h3parts, w - 104, 17);
      var h3h = Math.max(48, h3lines.length * 26 + 22);
      if (!dry) {
        ctx.fillStyle = T.h3Bg;
        roundRect(ctx, x, y, w, h3h, 10);
        ctx.fill();
        ctx.fillStyle = T.h3Badge;
        roundRect(ctx, x + 12, y + (h3h - 24) / 2, 26, 24, 6);
        ctx.fill();
        setFont(ctx, 13, true);
        ctx.fillStyle = T.h3BadgeText;
        ctx.textAlign = 'center';
        ctx.fillText('章', x + 25, y + h3h / 2 + 5);
        ctx.textAlign = 'left';
      }
      var yy = y + (h3h - h3lines.length * 26) / 2 + 18;
      if (dry) {
        yy += h3lines.length * 26;
      } else {
        drawLines(ctx, h3lines, x + 48, yy, 17, 26, T.h3Text, T.h3Text);
        if (h3text.ts) {
          setFont(ctx, 13, false);
          ctx.fillStyle = T.tsColor;
          ctx.textAlign = 'right';
          ctx.fillText(h3text.ts, x + w - 16, y + h3h / 2 + 5);
          ctx.textAlign = 'left';
        }
      }
      return y + h3h + 12;
    }

    if (b.type === 'li' || b.type === 'oli' || b.type === 'check') {
      y += 11;
      var ind = 26;
      lines = wrapInline(ctx, parseInline(b.text), w - ind - 6, 16);
      if (!dry) {
        if (b.type === 'check') {
          ctx.strokeStyle = T.checkBox;
          ctx.lineWidth = 1.6;
          roundRect(ctx, x + 2, y - 13, 15, 15, 4);
          ctx.stroke();
          if (b.checked) {
            ctx.fillStyle = T.h3Badge;
            roundRect(ctx, x + 2, y - 13, 15, 15, 4);
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + 5.5, y - 5.5);
            ctx.lineTo(x + 8.5, y - 3);
            ctx.lineTo(x + 13.5, y - 10);
            ctx.stroke();
          }
        } else if (b.type === 'oli') {
          setFont(ctx, 15, true);
          ctx.fillStyle = T.liDot;
          ctx.textAlign = 'right';
          ctx.fillText(b.index + '.', x + 20, y);
          ctx.textAlign = 'left';
        } else {
          ctx.fillStyle = T.liDot;
          ctx.beginPath();
          ctx.arc(x + 7, y - 5, 3.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return dry ? y + lines.length * 26
        : drawLines(ctx, lines, x + ind, y, 16, 26, T.liText, T.liBold) + 2;
    }

    if (b.type === 'table') {
      y += 16;
      var cols = b.headers.length || 1;
      var gap = 12;
      var cells = [b.headers].concat(b.rows);
      // 按内容长度分配列宽（避免"概念"列过宽、"说明"列挤压换行）
      var weights = [];
      var sumW = 0;
      for (k = 0; k < cols; k++) {
        var maxLen = 2;
        for (i = 0; i < cells.length; i++) {
          maxLen = Math.max(maxLen, String(cells[i][k] == null ? '' : cells[i][k]).length);
        }
        var wt = Math.min(maxLen, 26);
        weights.push(wt);
        sumW += wt;
      }
      var availW = w - gap * (cols - 1);
      var colWidths = [];
      var colX = [];
      var accX = x;
      for (k = 0; k < cols; k++) {
        var cw = Math.max(72, availW * weights[k] / sumW);
        colWidths.push(cw);
        colX.push(accX);
        accX += cw + gap;
      }
      var rowHeights = [];
      var rowLines = [];
      for (i = 0; i < cells.length; i++) {
        var maxLines = 1;
        var perCell = [];
        for (k = 0; k < cols; k++) {
          var cellLines = wrapInline(ctx, parseInline(cells[i][k] || ''), colWidths[k] - 22, 14);
          perCell.push(cellLines);
          maxLines = Math.max(maxLines, cellLines.length);
        }
        rowLines.push(perCell);
        rowHeights.push(maxLines * 22 + 18);
      }
      if (!dry) {
        for (i = 0; i < cells.length; i++) {
          var rh = rowHeights[i];
          ctx.fillStyle = i === 0 ? T.tableHeadBg : (i % 2 === 0 ? T.tableRowAlt : '#FFFFFF');
          roundRect(ctx, x, y, w, rh, i === 0 ? 9 : 0);
          ctx.fill();
          if (i > 0) {
            ctx.strokeStyle = T.tableBorder;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + w, y);
            ctx.stroke();
          }
        }
        ctx.strokeStyle = T.tableBorder;
        ctx.lineWidth = 1;
        roundRect(ctx, x, y, w, rowHeights.reduce(function (a, c) { return a + c; }, 0), 9);
        ctx.stroke();
      }
      var ry = y;
      for (i = 0; i < cells.length; i++) {
        for (k = 0; k < cols; k++) {
          var cx = colX[k];
          var ty = ry + 13;
          if (!dry) {
            var cl = rowLines[i][k];
            for (var li2 = 0; li2 < cl.length; li2++) {
              var p = cl[li2].parts[0] || { text: '', bold: false };
              setFont(ctx, 14, i === 0 || p.bold);
              ctx.fillStyle = i === 0 ? T.tableHeadText : T.tableText;
              ctx.fillText(cl[li2].parts.map(function (q) { return q.text; }).join(''), cx + 11, ty + li2 * 22);
            }
          }
        }
        ry += rowHeights[i];
      }
      return ry + 8;
    }

    if (b.type === 'quote') {
      y += 14;
      lines = wrapInline(ctx, parseInline(b.text), w - 24, 15);
      var qh = lines.length * 24 + 12;
      if (!dry) {
        ctx.fillStyle = T.quoteBar;
        roundRect(ctx, x + 4, y - 12, 3, qh - 4, 1.5);
        ctx.fill();
      }
      return dry ? y + qh : drawLines(ctx, lines, x + 20, y, 15, 24, T.quoteText, T.quoteText);
    }

    if (b.type === 'hr') {
      y += 22;
      if (!dry) {
        ctx.strokeStyle = T.hr;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - 11);
        ctx.lineTo(x + w, y - 11);
        ctx.stroke();
      }
      return y;
    }

    // 段落（含未识别的 h4-h6，按标题弱化处理）
    y += 13;
    var pSize = b.type === 'p' ? 16 : 15;
    lines = wrapInline(ctx, parseInline(b.text), w, pSize);
    return dry ? y + lines.length * 27
      : drawLines(ctx, lines, x, y, pSize, 27, T.liText, T.liBold) + 4;
  }

  /**
   * 把笔记 Markdown 渲染成一张 canvas（供导出 PNG）。
   * @param {string} markdown
   * @param {{title?:string,subtitle?:string,footer?:string}} meta
   * @param {{width?:number,scale?:number}} opts
   * @returns {HTMLCanvasElement}
   */
  function renderToCanvas(markdown, meta, opts) {
    var T = THEME;
    var o = opts || {};
    var W = o.width || T.width;
    var scale = o.scale || T.scale;
    var pad = T.pad;
    var innerW = W - pad * 2;
    var m = meta || {};

    var blocks = parseNoteBlocks(markdown);
    var title = m.title || '';
    if (blocks.length && blocks[0].type === 'h1') {
      if (!title) title = blocks[0].text;
      blocks = blocks.slice(1);
    }
    if (!title) title = '学习笔记';
    var subtitle = m.subtitle || '';

    var mc = document.createElement('canvas').getContext('2d');
    mc.textBaseline = 'alphabetic';
    var L = { pad: pad, innerW: innerW, startY: 0 };

    setFont(mc, 27, true);
    var titleLines = wrapInline(mc, [{ text: title, bold: true }], innerW - 56, 27);
    var headerH = Math.round(82 + titleLines.length * 38 + (subtitle ? 26 : 0));

    L.startY = pad + headerH + 26;
    var bodyEnd = L.startY;
    for (var i = 0; i < blocks.length; i++) {
      bodyEnd = drawBlock(mc, blocks[i], bodyEnd, L, true);
    }
    var footerH = 58;
    var totalH = Math.round(bodyEnd + footerH + pad);

    var canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = totalH * scale;
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, totalH);

    // ===== 顶部标题卡 =====
    var gx = pad, gy = pad, gw = innerW, gh = headerH;
    var grad = ctx.createLinearGradient(gx, gy, gx + gw, gy + gh);
    grad.addColorStop(0, T.headerFrom);
    grad.addColorStop(1, T.headerTo);
    ctx.fillStyle = grad;
    roundRect(ctx, gx, gy, gw, gh, 18);
    ctx.fill();

    setFont(ctx, 12, true);
    var tag = '学习笔记';
    var tagW = ctx.measureText(tag).width + 22;
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    roundRect(ctx, gx + 28, gy + 20, tagW, 24, 12);
    ctx.fill();
    ctx.fillStyle = T.headerSub;
    ctx.fillText(tag, gx + 39, gy + 36);

    setFont(ctx, 27, true);
    ctx.fillStyle = T.headerText;
    var tyBase = gy + 80;
    for (var tl = 0; tl < titleLines.length; tl++) {
      ctx.fillText(titleLines[tl].parts.map(function (p) { return p.text; }).join(''), gx + 28, tyBase + tl * 38);
    }
    if (subtitle) {
      setFont(ctx, 14, false);
      ctx.fillStyle = T.headerSub;
      ctx.fillText(subtitle, gx + 28, tyBase + titleLines.length * 38 + 2);
    }

    // ===== 正文 =====
    var y = L.startY;
    for (var j = 0; j < blocks.length; j++) {
      y = drawBlock(ctx, blocks[j], y, L, false);
    }

    // ===== 页脚 =====
    var fy = totalH - pad - 18;
    ctx.strokeStyle = T.hr;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, fy - 20);
    ctx.lineTo(pad + innerW, fy - 20);
    ctx.stroke();
    setFont(ctx, 12, false);
    ctx.fillStyle = T.footer;
    ctx.textAlign = 'center';
    ctx.fillText(m.footer || '由 B站字幕助手 生成', W / 2, fy + 2);
    ctx.textAlign = 'left';

    return canvas;
  }

  // ===== 9. AI 总结（LLM） =====

  /**
   * 调用 OpenAI 兼容接口。
   * @param {string} userPrompt 用户提示词
   * @param {string} [systemPrompt] 系统提示词（缺省使用通用 SYSTEM_PROMPT）
   * @returns {Promise<string>} 模型返回文本
   */
  async function callLLM(userPrompt, systemPrompt, options) {
    const o = options || {};
    // 允许调用方覆盖配置（供「测试连接」在未保存设置时用输入框当前值自检）
    const apiBase = String(o.apiBase || state.settings.apiBase || DEFAULT_SETTINGS.apiBase).replace(/\/+$/, '');
    const apiKey = String(o.apiKey != null ? o.apiKey : (state.settings.apiKey || ''));
    const model = String(o.model || state.settings.model || DEFAULT_SETTINGS.model);
    const rawTemp = Number(o.temperature != null ? o.temperature : state.settings.temperature);
    const temperature = isFinite(rawTemp) ? rawTemp : 0.3;
    const url = apiBase + '/chat/completions';
    const sys = (typeof systemPrompt === 'string' && systemPrompt) ? systemPrompt : SYSTEM_PROMPT;
    const payload = {
      model: model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: userPrompt }
      ],
      temperature: temperature,
      stream: false
    };
    if (typeof o.maxTokens === 'number' && o.maxTokens > 0) payload.max_tokens = o.maxTokens;
    const body = JSON.stringify(payload);

    let res;
    const startedAt = Date.now();
    try {
      res = await request({
        url: url,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey
        },
        data: body,
        timeout: 120000
      });
    } catch (e) {
      const waited = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      if (e && e.message === 'REQUEST_TIMEOUT') {
        throw new Error('请求超时（已等待 ' + waited + ' 秒）：可能是网络较慢或视频过长，请检查网络后重试。');
      }
      if (e && e.message === 'REQUEST_ABORT') {
        throw new Error('网络请求被中止，请重试。');
      }
      throw new Error('网络请求失败，请检查网络或代理设置。');
    }

    // HTTP 状态码 0 表示未收到有效响应（多为网络 / 代理问题）
    if (!res.status) {
      throw new Error('网络请求失败，请检查网络或代理设置（未收到有效响应）。');
    }

    const json = safeJson(res.responseText);
    if (res.status === 401 || res.status === 403) {
      throw new Error('API Key 无效或已过期，请到 platform.deepseek.com 重新生成后填入「设置」。');
    }
    if (res.status === 402) {
      throw new Error('账户余额不足，请到 platform.deepseek.com 充值（几元即可用很久）。');
    }
    if (res.status === 429) {
      throw new Error('请求过于频繁（已限流），请稍等一会再试。');
    }
    if (res.status >= 400) {
      const serverMsg =
        (json && json.error && json.error.message) ||
        (json && json.message) ||
        String(res.responseText || '').slice(0, 200);
      throw new Error(
        '接口返回错误（HTTP ' + res.status + '）' + (serverMsg ? '：' + serverMsg : '') +
        '。请检查 API Base 与模型名是否正确。'
      );
    }

    const content =
      json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) {
      if (o.allowEmpty) return '';
      throw new Error('模型返回内容为空，请检查模型名（当前：' + model + '）是否正确。');
    }
    return content;
  }

  /**
   * 设置总结状态文本。
   * @param {string} text
   */
  function setSumStatus(text) {
    const panel = state.ui.panel;
    if (!panel) return;
    const el = panel.querySelector('[data-role="sum-status"]');
    if (el) el.textContent = text;
  }

  /**
   * 渲染总结结果（纯文本等宽展示，避免引入外部 Markdown 库）。
   * @param {string} text
   */
  function renderSummary(text) {
    const panel = state.ui.panel;
    if (!panel) return;
    const el = panel.querySelector('[data-role="summary"]');
    el.textContent = text || '';
  }

  /**
   * 「测试连接」：用极短消息自检 API Key / 余额 / 网络 / 模型名，结果以 textContent 呈现。
   * 优先使用设置页输入框的当前值（支持「先测试后保存」）。
   */
  async function testConnection() {
    const panel = state.ui.panel;
    if (!panel) return;
    const q = (role) => panel.querySelector('[data-role="' + role + '"]');
    const setTest = (text) => {
      const el = q('test-status');
      if (el) el.textContent = String(text == null ? '' : text);
    };

    // 与「保存设置」共用 readFieldValue，统一 trim，避免读到带不可见空格的脏值；
    // 输入框为空时退回已保存设置，两者皆空则由下方 apiKey 校验拦截。
    const apiKey = readFieldValue('api-key') || state.settings.apiKey || '';
    const apiBase = readFieldValue('api-base') || state.settings.apiBase || '';
    const model = readFieldValue('model') || state.settings.model || '';

    if (!apiKey) {
      setTest('请先填写 API Key，再点「测试连接」。');
      toast('请先填写 API Key');
      return;
    }

    setTest('正在测试连接…');
    try {
      // HTTP 200 即视为连接正常；allowEmpty 避免因 max_tokens 过小导致「内容为空」误报
      await callLLM('ping', undefined, {
        apiKey: apiKey,
        apiBase: apiBase,
        model: model,
        temperature: 0,
        maxTokens: 8,
        allowEmpty: true
      });
      setTest('连接正常，模型 ' + (model || DEFAULT_SETTINGS.model) + ' 可用。');
      toast('连接正常');
    } catch (e) {
      const msg = (e && e.message) ? e.message : '连接失败（未知错误）';
      setTest('连接失败：' + msg);
      toast('连接失败：' + msg, 8000);
    }
  }

  /**
   * 生成总结（map-reduce）。
   * @param {string} [mode] 总结模式：'general'（默认，通用总结）| 'chapter'（章节化笔记）
   */
  async function generateSummary(mode) {
    const summaryMode = mode === 'chapter' ? 'chapter' : 'general';
    showPanel();
    switchTab('summary');
    if (!state.cues.length) {
      setSumStatus('总结失败');
      renderSummary('请先在「字幕」标签点击“抓取字幕”，拿到逐字稿后再生成总结。');
      toast('请先在「字幕」标签点击“抓取字幕”', 6000);
      return;
    }
    if (!state.settings.apiKey) {
      setSumStatus('请先在「设置」中填写 API Key');
      renderSummary('请先在「设置」标签填写 API Key 并保存，然后回到「总结」标签重新生成。');
      switchTab('settings');
      toast('请先在「设置」中填写 API Key');
      return;
    }
    setSumStatus('正在生成总结，请稍候…');
    renderSummary('正在生成总结，请稍候…');
    try {
      const finalText = summaryMode === 'chapter'
        ? await runCourseNoteSummary()
        : await runGeneralSummary();
      if (typeof finalText !== 'string' || !finalText.trim()) {
        throw new Error('模型未返回有效总结内容，请重试或更换模型。');
      }
      state.summaryText = finalText;
      renderSummary(finalText);
      setSumStatus('总结完成');
      toast('总结生成完成');
    } catch (e) {
      const msg = (e && e.message) ? e.message : '总结生成失败（未知错误）';
      state.summaryText = '';
      setSumStatus('总结失败');
      // 关键修复：失败时把错误留在结果区，用户不操作就不会消失（不再只闪一次 toast）
      renderSummary(
        '总结失败：' + msg + '\n\n' +
        '排查建议：到「设置」标签点“测试连接”，可一键自检 API Key / 余额 / 网络 / 模型名；' +
        '修正后回到「总结」重新生成。'
      );
      toast('总结失败：' + msg, 8000);
    }
  }

  /**
   * 通用总结链路（原有 map-reduce，行为保持不变）。
   * @returns {Promise<string>} 总结文本
   */
  async function runGeneralSummary() {
    const chunks = chunkTranscript(state.cues, 6000);
    if (!chunks.length) {
      throw new Error('逐字稿为空，无法生成总结。请先到「字幕」标签重新抓取字幕。');
    }
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      setSumStatus('正在总结 ' + (i + 1) + '/' + chunks.length + ' 段…');
      const prompt = buildSummaryPrompt(chunks[i], {
        mode: chunks.length > 1 ? 'detail' : 'final',
        title: state.title,
        template: state.settings.promptTemplate,
        index: i + 1,
        total: chunks.length
      });
      const text = await callLLM(prompt);
      partials.push(text);
    }

    if (!partials.length || !partials.join('').trim()) {
      throw new Error('模型未返回有效总结内容，请重试或更换模型。');
    }
    if (partials.length === 1) {
      return partials[0];
    }
    setSumStatus('正在合并总结…');
    return await callLLM(
      buildSummaryPrompt(partials.join('\n\n---\n\n'), {
        mode: 'merge',
        title: state.title,
        template: state.settings.promptTemplate
      })
    );
  }

  /**
   * 章节化笔记链路（map-reduce）。复用 chunkTranscript 分段；map 段用 buildCourseNotePrompt，
   * reduce 段用 buildCourseNoteReducePrompt 归并，最后 buildCourseNoteMarkdown 装配。
   * @returns {Promise<string>} 章节化笔记 Markdown
   */
  async function runCourseNoteSummary() {
    const chunks = chunkTranscript(state.cues, 6000);
    if (!chunks.length) {
      throw new Error('逐字稿为空，无法生成章节笔记。请先到「字幕」标签重新抓取字幕。');
    }
    const partials = [];
    for (let i = 0; i < chunks.length; i++) {
      setSumStatus('正在整理第 ' + (i + 1) + '/' + chunks.length + ' 段…');
      const p = buildCourseNotePrompt(chunks[i], {
        title: state.title,
        index: i + 1,
        total: chunks.length
      }, { mode: 'chapter', text: chunks[i] });
      const text = await callLLM(p.user, p.system);
      partials.push(text);
    }

    if (!partials.length || !partials.join('').trim()) {
      throw new Error('模型未返回有效章节笔记，请重试或更换模型。');
    }
    let noteText;
    if (partials.length === 1) {
      noteText = partials[0];
    } else {
      setSumStatus('正在合并章节笔记…');
      const rp = buildCourseNoteReducePrompt(partials, { title: state.title });
      noteText = await callLLM(rp.user, rp.system);
    }
    if (typeof noteText !== 'string' || !noteText.trim()) {
      throw new Error('模型未返回有效章节笔记，请重试或更换模型。');
    }
    return buildCourseNoteMarkdown(noteText, { title: state.title });
  }

  // ===== 10. SPA 路由监听与初始化 =====

  /**
   * 路由变化（站内换视频 / 换P / 换集）后重新初始化。
   */
  async function onRouteChange() {
    state.cues = [];
    state.subtitleItems = [];
    state.currentCueIndex = -1;
    state.summaryText = '';
    const video = getVideo();
    state.ui.boundVideo = null;
    if (video) bindVideoEvents(video);
    renderTranscript();
    renderSummary('');
    setSubStatus('');
    initForCurrentPage();
  }

  /**
   * 针对当前页面读取元信息并自动抓取字幕。
   */
  async function initForCurrentPage() {
    const meta = readVideoMeta();
    state.isBangumi = meta.isBangumi;
    state.bvid = meta.bvid;
    state.cid = meta.cid;
    state.epId = meta.epId;
    state.title = meta.title || '';
    await ensureVideoIdentity();
    // 自动尝试抓取一次
    doFetch(false);
  }

  /**
   * 安装 SPA 路由监听。
   */
  function installRouteWatcher() {
    let lastUrl = location.href;
    window.addEventListener('popstate', () => {
      setTimeout(onRouteChange, 800);
    });
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(onRouteChange, 800);
      }
    }, 1000);
  }

  // ===== 11. 入口 =====

  /**
   * 主入口：初始化设置、UI、事件与菜单命令。
   */
  function main() {
    loadSettings();
    ensureShadowHost();
    buildPanel();

    // 等待 video 元素出现后再绑定
    let tries = 0;
    const waitVideo = setInterval(() => {
      tries++;
      const video = getVideo();
      if (video) {
        clearInterval(waitVideo);
        bindVideoEvents(video);
        positionOverlay();
        startCaptionLoop();
      } else if (tries > 60) {
        clearInterval(waitVideo);
      }
    }, 500);

    // 窗口尺寸变化重新定位
    window.addEventListener('resize', positionOverlay);

    // 菜单命令
    try {
      GM_registerMenuCommand('显示/隐藏 面板', () => {
        if (state.ui.panel && state.ui.panel.style.display !== 'none') hidePanel();
        else showPanel();
      });
      GM_registerMenuCommand('抓取字幕', () => {
        showPanel();
        doFetch(true);
      });
      GM_registerMenuCommand('生成 AI 总结', () => {
        showPanel();
        switchTab('summary');
        generateSummary();
      });
    } catch (e) {
      // 某些环境不支持菜单命令，忽略
    }

    // 订阅字幕拖动（绑定到字幕元素上的鼠标事件）
    if (state.ui.overlayEl) {
      makeCaptionDraggable(state.ui.overlayEl);
    }

    initForCurrentPage();
    installRouteWatcher();
  }

  /**
   * 字幕层拖动（改变水平/底部偏移）。
   * @param {HTMLElement} el
   */
  function makeCaptionDraggable(el) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let origOffsetX = 0;
    let origBottom = 0;
    const onMove = (e) => {
      if (!dragging) return;
      state.settings.offsetX = origOffsetX + (e.clientX - startX);
      state.settings.bottomOffset = Math.max(0, origBottom - (e.clientY - startY));
      applyCaptionStyle();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      saveSettings();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
    };
    el.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      origOffsetX = state.settings.offsetX || 0;
      origBottom = state.settings.bottomOffset || 0;
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
      e.preventDefault();
      e.stopPropagation();
    });
  }

  // 仅在浏览器环境且有 document.location 时启动，保证 Node 加载无副作用
  if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.location) {
    try {
      main();
    } catch (e) {
      // 初始化异常不影响页面
    }
  }

  // ===== 12. 纯函数导出（供 Node 单测） =====
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      md5,
      getMixinKey,
      wbiSign,
      toSRT,
      toVTT,
      toTXT,
      toJSONText,
      formatTs,
      findCueIndexAt,
      chunkTranscript,
      buildSummaryPrompt,
      parseSubtitleBody,
      buildCourseNotePrompt,
      buildCourseNoteReducePrompt,
      buildCourseNoteMarkdown,
      parseNoteBlocks
    };
  }
})();
