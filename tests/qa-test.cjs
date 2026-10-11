'use strict';

/**
 * QA 独立验证套件 —— B站字幕助手油猴脚本
 *
 * 目标：真正跑起来验证 15 个导出纯函数的正确性，而非"看起来对"。
 * 依赖：仅 Node 内置模块（crypto / fs / path / assert），零第三方依赖。
 * 运行：node "tests/qa-test.cjs"
 *
 * 运行完成后打印按模块分组的统计表与失败明细，并以退出码反映结果
 * （0 = 全部通过，1 = 存在失败）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', 'bilibili-caption-summary.user.js');
const SRC_TEXT = fs.readFileSync(SRC, 'utf8');

// ===== 轻量测试框架 =====
const stats = new Map(); // module -> { pass, fail }
const failures = [];
const notes = []; // 反直觉 / 需报告的观察

function bucket(name) {
  if (!stats.has(name)) stats.set(name, { pass: 0, fail: 0 });
  return stats.get(name);
}

function test(moduleName, name, fn) {
  const b = bucket(moduleName);
  try {
    fn();
    b.pass++;
  } catch (e) {
    b.fail++;
    failures.push({ moduleName, name, msg: (e && e.message) || String(e) });
  }
}

function note(msg) {
  notes.push(msg);
}

// ===== 独立参考实现（刻意不复用被测源码逻辑） =====
// 官方固定混淆表（B站 WBI）。
const REF_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function refMixinKey(orig) {
  return REF_TAB.map((i) => orig[i]).join('').slice(0, 32);
}
function refMd5(s) {
  return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}
function refQuery(params) {
  return Object.keys(params)
    .sort()
    .map((k) => {
      const v = String(params[k]).replace(/[!'()*]/g, '');
      return encodeURIComponent(k) + '=' + encodeURIComponent(v);
    })
    .join('&');
}

// ============================================================
// 0. 加载 / 语法 / 无副作用 / 导出完整性
// ============================================================
const EXPECTED_EXPORTS = [
  'md5', 'getMixinKey', 'wbiSign', 'toSRT', 'toVTT', 'toTXT',
  'toJSONText', 'formatTs', 'findCueIndexAt', 'chunkTranscript',
  'buildSummaryPrompt', 'parseSubtitleBody',
  // 章节化笔记（增量改造新增）
  'buildCourseNotePrompt', 'buildCourseNoteReducePrompt', 'buildCourseNoteMarkdown',
  // 笔记图片渲染（Markdown 解析层，纯函数）
  'parseNoteBlocks'
];

let lib = null;
test('Load', 'require() 不抛错', () => {
  const beforeWin = typeof globalThis.window;
  const beforeDoc = typeof globalThis.document;
  lib = require(SRC);
  assert.strictEqual(typeof lib, 'object', 'module.exports 应为对象');
  // 无副作用：加载后不应引入 window / document
  assert.strictEqual(typeof globalThis.window, beforeWin, 'require 不应创建 window');
  assert.strictEqual(typeof globalThis.document, beforeDoc, 'require 不应创建 document');
  assert.strictEqual(typeof globalThis.window, 'undefined', 'Node 下 window 应为 undefined');
});

test('Load', '16 个导出函数全部存在且为 function', () => {
  for (const name of EXPECTED_EXPORTS) {
    assert.ok(Object.prototype.hasOwnProperty.call(lib, name), '缺少导出: ' + name);
    assert.strictEqual(typeof lib[name], 'function', name + ' 不是函数');
  }
  const keys = Object.keys(lib);
  assert.strictEqual(keys.length, EXPECTED_EXPORTS.length, '导出数量不符: ' + keys.join(','));
});

test('Load', '章节化笔记 3 个新导出存在（显式断言）', () => {
  const NEW_EXPORTS = [
    'buildCourseNotePrompt',
    'buildCourseNoteReducePrompt',
    'buildCourseNoteMarkdown'
  ];
  NEW_EXPORTS.forEach((name) => {
    assert.ok(Object.prototype.hasOwnProperty.call(lib, name), '缺少新增导出: ' + name);
    assert.strictEqual(typeof lib[name], 'function', name + ' 应为 function，实际 ' + typeof lib[name]);
    assert.strictEqual(typeof lib[name], 'function', name + ' 不是函数');
  });
  // 三个新函数彼此独立且均为具名 function（非箭头简写导致的匿名）
  assert.strictEqual(lib.buildCourseNotePrompt.name, 'buildCourseNotePrompt');
  assert.strictEqual(lib.buildCourseNoteReducePrompt.name, 'buildCourseNoteReducePrompt');
  assert.strictEqual(lib.buildCourseNoteMarkdown.name, 'buildCourseNoteMarkdown');
});

// ============================================================
// 1. MD5 正确性（用 Node crypto 交叉验证）
// ============================================================
(function md5Suite() {
  test('MD5', "md5('abc') 固定向量", () => {
    assert.strictEqual(lib.md5('abc'), '900150983cd24fb0d6963f7d28e17f72');
  });

  // 构造 ≥20 组输入
  const longAscii = 'x'.repeat(10000);
  const longCJK = '中文测试内容'.repeat(1250); // 15000 字符
  const inputs = [
    '',
    'a',
    'abc',
    'message digest',
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
    'The quick brown fox jumps over the lazy dog',
    '你好，世界',
    '中文字符串测试 · 多字节 UTF-8',
    '𝒳',                       // U+1D4B3 代理对
    '👨‍👩‍👧',                    // 多代理对 + ZWJ
    '🎉🎊🥳',                   // 多 emoji
    'a\0b\0c',                  // 含 NUL
    '\0',                       // 单个 NUL
    '  leading and trailing  ',
    longAscii,
    longCJK,
    '混合mixed中文emoji😀内容',
    JSON.stringify({ n: 123, s: '中', arr: [1, 2, 3] }),
    String(1234567890),
    '空格 与\t制表符\n换行'
  ];

  inputs.forEach((s, idx) => {
    test('MD5', '与 crypto 一致 #' + idx + ' (len=' + s.length + ')', () => {
      assert.strictEqual(lib.md5(s), refMd5(s));
    });
  });

  // padding 经典边界：字节长度 55/56/57/63/64/65
  const boundaries = [55, 56, 57, 63, 64, 65];
  boundaries.forEach((n) => {
    test('MD5', 'ASCII 边界字节长度 ' + n, () => {
      const s = 'a'.repeat(n);
      assert.strictEqual(Buffer.byteLength(s, 'utf8'), n);
      assert.strictEqual(lib.md5(s), refMd5(s));
    });
  });

  // 多字节构造出的等价字节长度边界（'é'=2 bytes, '中'=3 bytes, 'a'=1）
  const mbBoundaries = [
    ['é'.repeat(27) + 'a', 55],
    ['é'.repeat(28), 56],
    ['中'.repeat(18) + 'ab', 56],
    ['中'.repeat(19), 57],
    ['中'.repeat(21), 63],
    ['é'.repeat(32), 64],
    ['中'.repeat(21) + 'ab', 65]
  ];
  mbBoundaries.forEach(([s, n], i) => {
    test('MD5', '多字节边界 #' + i + ' (bytes=' + n + ')', () => {
      assert.strictEqual(Buffer.byteLength(s, 'utf8'), n, '构造错误，应=' + n);
      assert.strictEqual(lib.md5(s), refMd5(s));
    });
  });

  // 非字符串输入（内部 String()）
  test('MD5', '非字符串输入按 String() 处理', () => {
    assert.strictEqual(lib.md5(123), refMd5('123'));
    assert.strictEqual(lib.md5(null), refMd5('null'));
    assert.strictEqual(lib.md5(undefined), refMd5('undefined'));
  });
})();

// ============================================================
// 2. WBI 签名
// ============================================================
(function wbiSuite() {
  test('WBI', 'getMixinKey 对已知 64 字符 orig 的手工推导值', () => {
    const orig = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    assert.strictEqual(orig.length, 64);
    // 手工推导（不调用被测逻辑）：TAB 前 32 项 → 见注释推导
    const expected = 'uvSC1IXgPyKf6DtjbrFxhJqTdcOnMmpN';
    assert.strictEqual(lib.getMixinKey(orig), expected);
    // 与独立 REF_TAB 参考实现一致
    assert.strictEqual(lib.getMixinKey(orig), refMixinKey(orig));
  });

  test('WBI', '返回含 wts 与 w_rid 且 w_rid 为 32 位小写 hex', () => {
    const out = lib.wbiSign({ cid: 123 }, 'imgkey', 'subkey');
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'wts'));
    assert.ok(Object.prototype.hasOwnProperty.call(out, 'w_rid'));
    assert.strictEqual(typeof out.wts, 'number');
    assert.match(out.w_rid, /^[0-9a-f]{32}$/);
  });

  const paramSets = [
    { cid: 123, bvid: 'BV1xx411c7mD' },
    { cid: 0 },
    { cid: 999, ep_id: '12345' },
    { a: 1, b: 2, c: 3, d: 4 },
    { cid: 456789, type: 'video', lang: 'zh-CN' },
    { foo: 'bar', baz: 'qux', wtsx: 'unused' }
  ];
  paramSets.forEach((p, i) => {
    test('WBI', '独立复算 w_rid #' + i, () => {
      const img = '7cd084941338484aae1ad9425b84077c';
      const sub = '4932caff0ff746eab6f01bf08b70ac45';
      const out = lib.wbiSign(p, img, sub);
      const mixin = refMixinKey(img + sub);
      const expectRid = refMd5(refQuery(Object.assign({}, p, { wts: out.wts })) + mixin);
      assert.strictEqual(out.w_rid, expectRid);
    });
  });

  // 边界值
  const edgeCases = [
    { '': '' },
    { k: '' },
    { 'a b': 'c d' },
    { special: "!'\()*" },
    { special: "abc!'()*def" },
    { 中文键: '中文值' },
    { snake_case_key: 'value' },
    {} // 空对象
  ];
  edgeCases.forEach((p, i) => {
    test('WBI', '边界参数集 #' + i + ' (' + JSON.stringify(p) + ')', () => {
      const out = lib.wbiSign(p, 'ik', 'sk');
      const mixin = refMixinKey('ik' + 'sk');
      const expectRid = refMd5(refQuery(Object.assign({}, p, { wts: out.wts })) + mixin);
      assert.strictEqual(out.w_rid, expectRid);
      assert.match(out.w_rid, /^[0-9a-f]{32}$/);
    });
  });

  test('WBI', '输入 params 不被 mutate 破坏', () => {
    const orig = { cid: 42, bvid: 'BV1' };
    const snapshot = JSON.stringify(orig);
    lib.wbiSign(orig, 'ik', 'sk');
    assert.strictEqual(JSON.stringify(orig), snapshot, 'wbiSign 修改了输入对象');
  });

  test('WBI', 'imgKey/subKey 缺失（undefined）时仍产出合法签名', () => {
    const out = lib.wbiSign({ cid: 1 });
    assert.match(out.w_rid, /^[0-9a-f]{32}$/);
    const mixin = refMixinKey('');
    const expectRid = refMd5(refQuery(Object.assign({}, { cid: 1 }, { wts: out.wts })) + mixin);
    assert.strictEqual(out.w_rid, expectRid);
  });
})();

// ============================================================
// 3. 时间戳 / 导出格式转换
// ============================================================
(function formatSuite() {
  test('Format', 'formatTs 基础用例', () => {
    assert.strictEqual(lib.formatTs(0), '00:00:00,000');
    assert.strictEqual(lib.formatTs(59.999), '00:00:59,999');
    assert.strictEqual(lib.formatTs(3599.999), '00:59:59,999');
    assert.strictEqual(lib.formatTs(3661.5), '01:01:01,500');
    assert.strictEqual(lib.formatTs(3600), '01:00:00,000');
    assert.strictEqual(lib.formatTs(1.234), '00:00:01,234');
  });

  test('Format', 'formatTs 负数与 NaN 行为（记录实际结果）', () => {
    const neg = lib.formatTs(-5);
    const nan = lib.formatTs(NaN);
    note('formatTs(-5) => ' + neg + '；formatTs(NaN) => ' + nan + '（实现将非法值归零）');
    assert.strictEqual(neg, '00:00:00,000');
    assert.strictEqual(nan, '00:00:00,000');
  });

  test('Format', 'formatTs sep/ms 选项', () => {
    assert.strictEqual(lib.formatTs(1.5, { sep: '.' }), '00:00:01.500');
    assert.strictEqual(lib.formatTs(1.5, { ms: false }), '00:00:01');
    // ms 进位封顶
    assert.strictEqual(lib.formatTs(1.9999), '00:00:01,999');
  });

  const cues = [
    { start: 0, end: 1.5, text: '第一句' },
    { start: 1.5, end: 2.25, text: 'second line' },
    { start: 3.001, end: 4.5, text: '含标点, 逗号. 句号' },
    { start: 12.345, end: 61.2, text: 'line A\nline B' },
    { start: 3723.456, end: 3725.0, text: '超过一小时' }
  ];

  function msToSec(h, m, s, ms) { return h * 3600 + m * 60 + s + ms / 1000; }
  const TS_RE = /^(\d{2}):(\d{2}):(\d{2})[,.](\d{3}) --> (\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/;

  test('Format', 'toSRT 严格正则逐条校验', () => {
    const out = lib.toSRT(cues);
    const norm = out.replace(/\r\n/g, '\n');
    const blocks = norm.trimEnd().split('\n\n');
    assert.strictEqual(blocks.length, cues.length, '块数不符');
    blocks.forEach((b, i) => {
      const lines = b.split('\n');
      assert.match(lines[0], /^\d+$/, '序号行应为纯数字: ' + lines[0]);
      assert.strictEqual(Number(lines[0]), i + 1, '序号应从 1 连续递增');
      assert.match(lines[1], TS_RE, '时间轴行格式错误: ' + lines[1]);
      assert.ok(!/,\s*-->|-->.*[.]/.test(lines[1].replace(/,(\d{3})/g, ',$1')), 'SRT 必须用逗号');
      assert.ok(lines[1].indexOf(',') >= 0, 'SRT 时间轴应含逗号');
    });
  });

  test('Format', 'toSRT 序号从 1 连续递增', () => {
    const out = lib.toSRT(cues).replace(/\r\n/g, '\n');
    const idxs = out.trimEnd().split('\n\n').map((b) => Number(b.split('\n')[0]));
    assert.deepStrictEqual(idxs, [1, 2, 3, 4, 5]);
  });

  test('Format', 'toSRT round-trip 反解析一致', () => {
    const out = lib.toSRT(cues);
    const parsed = [];
    out.replace(/\r\n/g, '\n').trimEnd().split('\n\n').forEach((b) => {
      const lines = b.split('\n');
      const m = TS_RE.exec(lines[1]);
      parsed.push({
        start: msToSec(+m[1], +m[2], +m[3], +m[4]),
        end: msToSec(+m[5], +m[6], +m[7], +m[8]),
        text: lines.slice(2).join('\n')
      });
    });
    assert.strictEqual(parsed.length, cues.length);
    parsed.forEach((p, i) => {
      assert.ok(Math.abs(p.start - cues[i].start) < 0.001, 'start 往返不一致 #' + i);
      assert.ok(Math.abs(p.end - cues[i].end) < 0.001, 'end 往返不一致 #' + i);
      assert.strictEqual(p.text, cues[i].text, 'text 往返不一致 #' + i);
    });
  });

  test('Format', 'toSRT 空 cues 输出合理（空字符串）', () => {
    assert.strictEqual(lib.toSRT([]), '');
    assert.strictEqual(lib.toSRT(null), '');
  });

  test('Format', 'toVTT 首行为 WEBVTT 且无逗号', () => {
    const out = lib.toVTT(cues);
    assert.strictEqual(out.split('\n')[0], 'WEBVTT');
    // 时间轴段不得出现逗号（文本中的逗号允许）
    const tsLines = out.split('\n').filter((l) => l.indexOf(' --> ') >= 0);
    tsLines.forEach((l) => {
      assert.ok(l.indexOf(',') === -1, 'VTT 时间轴不应含逗号: ' + l);
      assert.match(l, TS_RE, 'VTT 时间轴格式错误: ' + l);
    });
  });

  test('Format', 'toVTT round-trip 反解析一致', () => {
    const out = lib.toVTT(cues);
    const lines = out.split('\n');
    assert.strictEqual(lines[0], 'WEBVTT');
    const body = lines.slice(1).join('\n').trim().split('\n\n');
    const parsed = body.map((b) => {
      const ls = b.split('\n');
      const m = TS_RE.exec(ls[0]);
      return { start: msToSec(+m[1], +m[2], +m[3], +m[4]), end: msToSec(+m[5], +m[6], +m[7], +m[8]), text: ls.slice(1).join('\n') };
    });
    assert.strictEqual(parsed.length, cues.length);
    parsed.forEach((p, i) => {
      assert.ok(Math.abs(p.start - cues[i].start) < 0.001);
      assert.ok(Math.abs(p.end - cues[i].end) < 0.001);
      assert.strictEqual(p.text, cues[i].text);
    });
  });

  test('Format', 'toVTT 空 cues 仅返回头', () => {
    assert.strictEqual(lib.toVTT([]), 'WEBVTT\n\n');
  });

  test('Format', 'toTXT 带/不带时间戳', () => {
    const withTs = lib.toTXT(cues, true);
    const noTs = lib.toTXT(cues, false);
    // 逐条精确比对（注意其中一条文本内含换行，行数不等于条目数，故按拼接结果比对）
    const expectedWithTs = cues.map((c) => '[' + lib.formatTs(c.start, { ms: false }) + '] ' + c.text).join('\n');
    assert.strictEqual(withTs, expectedWithTs, '带时间戳输出与逐条拼接不一致');
    assert.ok(withTs.indexOf('[00:00:00] 第一句') >= 0);
    assert.ok(withTs.indexOf('[01:02:03] 超过一小时') >= 0, '1h3s 应为 01:02:03');
    assert.strictEqual(noTs, cues.map((c) => c.text).join('\n'));
    // 仅含简单文本的用例，保证行数精确
    const simple = [{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'b' }];
    assert.strictEqual(lib.toTXT(simple, true), '[00:00:00] a\n[00:00:01] b');
    assert.strictEqual(lib.toTXT(simple, false), 'a\nb');
  });

  test('Format', 'toJSONText 可 JSON.parse 且深相等', () => {
    const out = lib.toJSONText(cues);
    assert.deepStrictEqual(JSON.parse(out), cues);
    assert.strictEqual(lib.toJSONText(null), '[]');
  });
})();

// ============================================================
// 4. findCueIndexAt 边界矩阵 + 随机对拍
// ============================================================
(function findSuite() {
  const base = [
    { start: 0, end: 1, text: 'a' },
    { start: 2, end: 3, text: 'b' },
    { start: 4, end: 5, text: 'c' }
  ];
  test('FindCue', '空数组', () => assert.strictEqual(lib.findCueIndexAt([], 1), -1));
  test('FindCue', 't 小于首条 start', () => assert.strictEqual(lib.findCueIndexAt(base, -1), -1));
  test('FindCue', 't 恰等于某条 start', () => assert.strictEqual(lib.findCueIndexAt(base, 2), 1));
  test('FindCue', 't 恰等于某条 end', () => assert.strictEqual(lib.findCueIndexAt(base, 3), 1));
  test('FindCue', 't 落在两条字幕空隙中 → -1', () => {
    assert.strictEqual(lib.findCueIndexAt(base, 1.5), -1);
  });
  test('FindCue', 't 大于末条 end', () => assert.strictEqual(lib.findCueIndexAt(base, 10), -1));
  test('FindCue', '只有 1 条', () => {
    assert.strictEqual(lib.findCueIndexAt([{ start: 0, end: 2, text: 'x' }], 1), 0);
    assert.strictEqual(lib.findCueIndexAt([{ start: 0, end: 2, text: 'x' }], 3), -1);
  });
  test('FindCue', '相邻重叠（前条 end > 后条 start）', () => {
    const ov = [{ start: 0, end: 2, text: 'a' }, { start: 1, end: 3, text: 'b' }];
    // 二分取"最后一个 start<=t"，重叠时后一条命中
    assert.strictEqual(lib.findCueIndexAt(ov, 1.5), 1);
    assert.strictEqual(lib.findCueIndexAt(ov, 0.5), 0);
  });
  test('FindCue', '非整数时间', () => {
    assert.strictEqual(lib.findCueIndexAt(base, 3.14159), -1);
    assert.strictEqual(lib.findCueIndexAt(base, 2.5), 1);
  });
  test('FindCue', 'cues 未排序时的行为（记录）', () => {
    const uns = [{ start: 4, end: 5, text: 'c' }, { start: 0, end: 1, text: 'a' }];
    const r = lib.findCueIndexAt(uns, 0.5);
    note('未排序 cues 时 findCueIndexAt(_,0.5) => ' + r + '（二分要求 start 升序前置条件；未排序结果不可靠，属预期）');
    assert.strictEqual(typeof r, 'number');
  });

  test('FindCue', '10ms 容差行为（记录反直觉点）', () => {
    // 设计约定为 start<=t<=end；实现允许 t<=end+0.01
    const r = lib.findCueIndexAt([{ start: 0, end: 1, text: 'a' }], 1.005);
    note('t=end+0.005 时返回 ' + r + '（实现含 10ms 容差，放宽了 start<=t<=end 的严格约定）');
    // 超过容差应返回 -1
    assert.strictEqual(lib.findCueIndexAt([{ start: 0, end: 1, text: 'a' }], 1.02), -1);
  });

  // 随机对拍：线性扫描参考实现（语义与实现契约一致：t<=end+0.01）
  function refFind(cues, t) {
    if (!isFinite(t) || !cues.length) return -1;
    let ans = -1;
    for (let i = 0; i < cues.length; i++) {
      const s = Number(cues[i].start);
      if (isFinite(s) && s <= t) ans = i;
    }
    if (ans === -1) return -1;
    const end = Number(cues[ans].end);
    if (!isFinite(end) || t <= end + 0.01) return ans;
    return -1;
  }

  test('FindCue', '随机对拍 ≥200 组', () => {
    let checked = 0;
    for (let iter = 0; iter < 300; iter++) {
      const n = 1 + Math.floor(Math.random() * 8);
      const cues = [];
      let cur = Math.random() * 2;
      for (let i = 0; i < n; i++) {
        const dur = 0.3 + Math.random() * 3;
        cues.push({ start: +cur.toFixed(4), end: +(cur + dur).toFixed(4), text: 't' + i });
        cur += 0.1 + Math.random() * 3; // 允许空隙，偶尔重叠
      }
      const t = +(Math.random() * (cur + 2) - 1).toFixed(4);
      const got = lib.findCueIndexAt(cues, t);
      const exp = refFind(cues, t);
      assert.strictEqual(got, exp, '对拍不一致 cues=' + JSON.stringify(cues) + ' t=' + t);
      checked++;
    }
    assert.ok(checked >= 200, '随机用例数不足: ' + checked);
    note('findCueIndexAt 随机对拍 ' + checked + ' 组全部与线性扫描参考实现一致');
  });
})();

// ============================================================
// 5. chunkTranscript / parseSubtitleBody / buildSummaryPrompt
// ============================================================
(function chunkSuite() {
  function entry(c) { return '[' + lib.formatTs(c.start, { ms: false }) + '] ' + c.text; }

  const cues = [];
  for (let i = 0; i < 60; i++) {
    cues.push({ start: i * 2, end: i * 2 + 1.5, text: '这是第 ' + i + ' 句测试文本，用于验证分块不丢内容不重复。' });
  }

  test('Chunk', '每块字符数 ≤ maxChars（单句不超限时）', () => {
    const chunks = lib.chunkTranscript(cues, 200);
    assert.ok(chunks.length > 1, '应产生多块');
    chunks.forEach((c, i) => assert.ok(c.length <= 200, '第 ' + i + ' 块超限: ' + c.length));
  });

  test('Chunk', '拼接后不丢文本、不重复', () => {
    const chunks = lib.chunkTranscript(cues, 200);
    const joined = chunks.join('\n');
    const expected = cues.map(entry).join('\n');
    assert.strictEqual(joined, expected, '分块拼接与原文不一致');
  });

  test('Chunk', '空 cues → 空数组', () => {
    assert.deepStrictEqual(lib.chunkTranscript([], 100), []);
    assert.deepStrictEqual(lib.chunkTranscript(null, 100), []);
  });

  test('Chunk', '单条超长 cue（记录超限情形）', () => {
    const long = [{ start: 0, end: 1, text: 'x'.repeat(500) }];
    const chunks = lib.chunkTranscript(long, 100);
    note('单条 500 字符 cue + maxChars=100 时块长度 = ' + chunks[0].length + '（单句本身超限，实现允许该块超限，符合设计预期）');
    assert.strictEqual(chunks.length, 1);
    assert.ok(chunks[0].length > 100);
  });

  test('Chunk', '恰好等于 maxChars 边界不提前断开', () => {
    // 构造 entry 恰好等于 limit 的单条
    const c1 = [{ start: 0, end: 1, text: 'a'.repeat(50) }];
    const e = entry(c1[0]); // 长度固定
    const chunks = lib.chunkTranscript(c1, e.length);
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0], e);
    // 恰好放不下第二条
    const c2 = [c1[0], { start: 1, end: 2, text: 'b'.repeat(50) }];
    const chunks2 = lib.chunkTranscript(c2, e.length);
    assert.strictEqual(chunks2.length, 2);
  });

  test('Chunk', '默认 maxChars=6000', () => {
    const many = [];
    for (let i = 0; i < 400; i++) many.push({ start: i, end: i + 1, text: '句子' + i });
    const chunks = lib.chunkTranscript(many); // 不传 maxChars
    chunks.forEach((c) => assert.ok(c.length <= 6000, '默认上限失效: ' + c.length));
  });
})();

(function parseSuite() {
  test('Parse', '正常 body 数组', () => {
    const data = { body: [{ from: 0, to: 1.5, content: '你好' }, { from: 1.5, to: 2, content: '世界' }] };
    assert.deepStrictEqual(lib.parseSubtitleBody(data), [
      { start: 0, end: 1.5, text: '你好' },
      { start: 1.5, end: 2, text: '世界' }
    ]);
  });

  test('Parse', 'JSON 字符串输入', () => {
    const s = JSON.stringify({ body: [{ from: 1, to: 2, content: 'x' }] });
    assert.deepStrictEqual(lib.parseSubtitleBody(s), [{ start: 1, end: 2, text: 'x' }]);
  });

  test('Parse', '非法 JSON 字符串 → []', () => {
    assert.deepStrictEqual(lib.parseSubtitleBody('{not json'), []);
  });

  test('Parse', 'body 为空数组 / 缺失 / 非数组', () => {
    assert.deepStrictEqual(lib.parseSubtitleBody({ body: [] }), []);
    assert.deepStrictEqual(lib.parseSubtitleBody({}), []);
    assert.deepStrictEqual(lib.parseSubtitleBody({ body: 'x' }), []);
    assert.deepStrictEqual(lib.parseSubtitleBody(null), []);
    assert.deepStrictEqual(lib.parseSubtitleBody(undefined), []);
  });

  test('Parse', '元素缺 from → 跳过；缺 to → end=start；null 元素 → 跳过', () => {
    const data = {
      body: [
        { to: 1, content: 'no-from' },      // 跳过
        { from: 2, content: 'no-to' },      // end=2
        null,                                // 跳过
        { from: 3, to: 4, content: '' },    // 空文本保留
        { from: 5, to: 6 }                   // content 缺失 → ''
      ]
    };
    const out = lib.parseSubtitleBody(data);
    assert.deepStrictEqual(out, [
      { start: 2, end: 2, text: 'no-to' },
      { start: 3, end: 4, text: '' },
      { start: 5, end: 6, text: '' }
    ]);
  });

  test('Parse', '返回结构类型约束 [{start:number,end:number,text:string}]', () => {
    const out = lib.parseSubtitleBody({ body: [{ from: 0, to: 1, content: 'a' }] });
    out.forEach((c) => {
      assert.strictEqual(typeof c.start, 'number');
      assert.strictEqual(typeof c.end, 'number');
      assert.strictEqual(typeof c.text, 'string');
      assert.deepStrictEqual(Object.keys(c).sort(), ['end', 'start', 'text']);
    });
  });
})();

(function promptSuite() {
  const transcript = '[00:00:00] 大家好\n[00:00:02] 今天讲测试';
  const TITLES = ['一句话概括', '核心观点', '内容脉络', '关键结论与行动项', '金句摘录'];

  test('Prompt', '默认 final 模式含逐字稿与五个章节标题', () => {
    const p = lib.buildSummaryPrompt(transcript, {});
    assert.ok(p.indexOf(transcript) >= 0, '未包含逐字稿原文');
    TITLES.forEach((t) => assert.ok(p.indexOf('## ' + t) >= 0, '缺少章节: ' + t));
  });

  test('Prompt', 'detail 模式含逐字稿与序号', () => {
    const p = lib.buildSummaryPrompt(transcript, { mode: 'detail', index: 2, total: 5 });
    assert.ok(p.indexOf(transcript) >= 0);
    assert.ok(p.indexOf('2/5') >= 0);
  });

  test('Prompt', 'merge 模式含五个章节标题', () => {
    const p = lib.buildSummaryPrompt('要点1\n要点2', { mode: 'merge' });
    TITLES.forEach((t) => assert.ok(p.indexOf('## ' + t) >= 0, '缺少章节: ' + t));
    assert.ok(p.indexOf('要点1') >= 0);
  });

  test('Prompt', '自定义模板占位符替换', () => {
    const p = lib.buildSummaryPrompt(transcript, { template: '标题:{{title}}\n正文:\n{{transcript}}', title: '我的视频' });
    assert.ok(p.indexOf('标题:我的视频') >= 0);
    assert.ok(p.indexOf(transcript) >= 0);
    assert.ok(p.indexOf('{{transcript}}') === -1, '占位符未替换');
  });

  test('Prompt', '超长 transcript 行为（记录，不做长度截断）', () => {
    const big = 'x'.repeat(50000);
    const p = lib.buildSummaryPrompt(big, {});
    note('buildSummaryPrompt 对 50000 字符 transcript 不截断，输出长度 = ' + p.length + '（截断在 chunkTranscript 层完成）');
    assert.ok(p.indexOf(big) >= 0);
  });
})();

// ============================================================
// 6. 静态审查
// ============================================================
(function staticSuite() {
  const lines = SRC_TEXT.split('\n');
  function lineOf(sub, from) {
    for (let i = from || 0; i < lines.length; i++) if (lines[i].indexOf(sub) >= 0) return i + 1;
    return -1;
  }

  test('Static', 'MIXIN_KEY_ENC_TAB 为 0..63 的排列', () => {
    const m = /MIXIN_KEY_ENC_TAB\s*=\s*\[([\s\S]*?)\]/.exec(SRC_TEXT);
    assert.ok(m, '未找到 MIXIN_KEY_ENC_TAB');
    const nums = m[1].split(',').map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    assert.strictEqual(nums.length, 64, '元素数应为 64，实际 ' + nums.length);
    assert.deepStrictEqual(nums.slice().sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i), '不是 0..63 的排列');
  });

  test('Static', '使用 GM_xmlhttpRequest（跨域）', () => {
    assert.ok(SRC_TEXT.indexOf('GM_xmlhttpRequest(') >= 0);
    assert.ok(SRC_TEXT.indexOf('@grant') >= 0);
  });

  test('Static', 'request() 设置超时且 onerror/ontimeout/onabort 均处理', () => {
    ['ontimeout', 'onerror', 'onabort', 'onload'].forEach((h) => {
      assert.ok(SRC_TEXT.indexOf(h + ':') >= 0, '缺少 ' + h);
    });
    assert.ok(/timeout:\s*30000/.test(SRC_TEXT), '默认超时未设置');
    assert.ok(/timeout:\s*120000/.test(SRC_TEXT), 'LLM 超时未设置');
  });

  test('Static', '使用 Shadow DOM 隔离面板与字幕层', () => {
    const n = (SRC_TEXT.match(/attachShadow\(/g) || []).length;
    assert.ok(n >= 2, 'attachShadow 调用应 ≥2（面板+字幕层），实际 ' + n);
  });

  test('Static', '监听 video 的 ended 事件', () => {
    assert.ok(SRC_TEXT.indexOf("addEventListener('ended'") >= 0);
    assert.ok(SRC_TEXT.indexOf('onVideoEnded') >= 0);
  });

  test('Static', 'unsafeWindow 做兼容取值', () => {
    assert.ok(/typeof\s+unsafeWindow\s*!==\s*'undefined'/.test(SRC_TEXT));
  });

  test('Static', 'SPA 路由变化重新初始化', () => {
    assert.ok(SRC_TEXT.indexOf('popstate') >= 0);
    assert.ok(SRC_TEXT.indexOf('onRouteChange') >= 0);
    assert.ok(SRC_TEXT.indexOf('installRouteWatcher') >= 0);
  });

  test('Static', '无字幕时给出明确提示（非静默失败）', () => {
    assert.ok(SRC_TEXT.indexOf('没有可用的 CC/AI 字幕') >= 0, '未发现无字幕提示文案');
  });

  test('Static', '字幕/LLM 渲染使用 textContent（防 XSS）', () => {
    // 关键渲染点必须用 textContent
    assert.ok(/el\.textContent\s*=\s*text/.test(SRC_TEXT), 'updateCaption 应使用 textContent');
    assert.ok(/el\.textContent\s*=\s*text\s*\|\|\s*''/.test(SRC_TEXT), 'renderSummary 应使用 textContent');
    assert.ok(/pre\.textContent\s*=/.test(SRC_TEXT), 'renderTranscript 应使用 textContent');
  });

  test('Static', 'innerHTML 仅用于静态结构，不注入不可信内容', () => {
    const innerHtmlLines = [];
    lines.forEach((l, i) => { if (/\.innerHTML\s*=/.test(l)) innerHtmlLines.push(i + 1); });
    note('innerHTML 赋值出现在行: ' + innerHtmlLines.join(', ') + '（仅 buildPanel 静态骨架与清空下拉，未拼接字幕/LLM 文本）');
    // 断言 panel.innerHTML 赋值行不含变量插值拼接
    innerHtmlLines.forEach((ln) => {
      const l = lines[ln - 1];
      assert.ok(!/\+[^']*\+/.test(l.replace(/'\s*\+\s*'/g, '')), 'innerHTML 疑似拼接动态内容: 行' + ln);
    });
    // 明确清空用法
    assert.ok(lines.some((l) => /sel\.innerHTML\s*=\s*''/.test(l)), '下拉清空应使用 innerHTML=\'\'');
  });

  test('Static', 'API Key 未被打印到日志', () => {
    const bad = [];
    lines.forEach((l, i) => {
      if (/console\.(log|error|warn|info)/.test(l) && /apiKey|api_key|Authorization|Bearer/i.test(l)) {
        bad.push(i + 1);
      }
    });
    assert.deepStrictEqual(bad, [], '疑似日志泄露 Key 的行: ' + bad.join(','));
    // 代码中不应存在任何 console.log
    const logs = lines.filter((l) => /console\.(log|error|warn|info)/.test(l));
    note('源码中 console.* 调用数量 = ' + logs.length);
  });

  test('Static', '字幕抓取失败路径均被 try/catch 包裹', () => {
    assert.ok(SRC_TEXT.indexOf('state.fetching = false') >= 0, 'should have finally reset');
    assert.ok(/catch\s*\(e\)/.test(SRC_TEXT));
  });
})();

// ============================================================
// 7. 章节化笔记（增量改造新增）—— buildCourseNotePrompt / Reduce / Markdown
// ============================================================
(function courseNoteSuite() {
  const cues = [
    { start: 0, end: 3, text: '大家好，今天讲数据结构' },
    { start: 3, end: 8, text: '第一部分：数组' },
    { start: 8, end: 15, text: '接下来我们看链表' }
  ];
  const meta = { title: '数据结构入门', index: 1, total: 3 };

  // ---------- buildCourseNotePrompt ----------
  test('CourseNote', 'buildCourseNotePrompt 返回 {system,user} 且均为非空字符串', () => {
    const out = lib.buildCourseNotePrompt(cues, meta, {});
    assert.strictEqual(typeof out, 'object');
    assert.strictEqual(typeof out.system, 'string');
    assert.strictEqual(typeof out.user, 'string');
    assert.ok(out.system.length > 0, 'system 不应为空');
    assert.ok(out.user.length > 0, 'user 不应为空');
    assert.deepStrictEqual(Object.keys(out).sort(), ['system', 'user'], '返回对象键应恰为 system/user');
  });

  test('CourseNote', 'buildCourseNotePrompt.system 含章节化笔记关键约束', () => {
    const out = lib.buildCourseNotePrompt(cues, meta);
    ['章节笔记', 'Markdown', '不编造', '知识点', '时间戳'].forEach((kw) => {
      assert.ok(out.system.indexOf(kw) >= 0, 'system 缺少约束关键词: ' + kw);
    });
    // 分层「章 → 节 → 知识点 → 要点」
    assert.ok(out.system.indexOf('章') >= 0 && out.system.indexOf('节') >= 0 && out.system.indexOf('知识点') >= 0);
  });

  test('CourseNote', 'buildCourseNotePrompt.user 含逐字稿文本与课程标题', () => {
    const out = lib.buildCourseNotePrompt(cues, meta);
    assert.ok(out.user.indexOf('[00:00:00] 大家好，今天讲数据结构') >= 0, 'user 未含逐字稿首条');
    assert.ok(out.user.indexOf('[00:00:08] 接下来我们看链表') >= 0, 'user 未含逐字稿末条');
    assert.ok(out.user.indexOf('数据结构入门') >= 0, 'user 未含课程标题');
  });

  test('CourseNote', 'buildCourseNotePrompt.user 保留每条 [时间戳] 前缀', () => {
    const out = lib.buildCourseNotePrompt(cues, { title: 'T' });
    cues.forEach((c) => {
      const ts = lib.formatTs(c.start, { ms: false });
      assert.ok(out.user.indexOf('[' + ts + '] ' + c.text) >= 0, '缺少时间戳行: ' + ts);
    });
  });

  test('CourseNote', 'buildCourseNotePrompt 多段（total>1）含 第 x/total 部分提示', () => {
    const out = lib.buildCourseNotePrompt(cues, { title: 'T', index: 2, total: 3 }, {});
    assert.ok(out.user.indexOf('第 2/3') >= 0, '多段应含进度提示');
  });

  test('CourseNote', 'buildCourseNotePrompt 单段（total<=1）不含部分提示', () => {
    const out = lib.buildCourseNotePrompt(cues, { title: 'T', index: 1, total: 1 });
    assert.ok(out.user.indexOf('部分，请只整理') === -1, '单段不应含分段提示');
  });

  test('CourseNote', 'buildCourseNotePrompt opts.text 直传纯文本块（map 阶段）', () => {
    const out = lib.buildCourseNotePrompt([], { title: 'T' }, { text: 'RAW-BLOCK-123' });
    assert.ok(out.user.indexOf('RAW-BLOCK-123') >= 0, 'opts.text 未生效');
  });

  test('CourseNote', 'buildCourseNotePrompt 空 cues 不抛异常且结构完整', () => {
    const out = lib.buildCourseNotePrompt([], {});
    assert.strictEqual(typeof out.system, 'string');
    assert.strictEqual(typeof out.user, 'string');
    assert.ok(out.system.length > 0 && out.user.length > 0);
  });

  test('CourseNote', 'buildCourseNotePrompt 无 meta / 缺省参数健壮（不抛异常）', () => {
    assert.doesNotThrow(() => lib.buildCourseNotePrompt(cues));
    assert.doesNotThrow(() => lib.buildCourseNotePrompt());
    assert.doesNotThrow(() => lib.buildCourseNotePrompt(null, null, null));
    assert.doesNotThrow(() => lib.buildCourseNotePrompt(cues, undefined, undefined));
    const out = lib.buildCourseNotePrompt(cues);
    assert.strictEqual(typeof out.user, 'string');
    assert.ok(out.user.indexOf('数据结构入门') === -1, '无 meta 时不应出现标题占位残留');
  });

  test('CourseNote', 'buildCourseNotePrompt.user 含章节骨架标题', () => {
    const out = lib.buildCourseNotePrompt(cues, meta);
    ['一句话总览', '章节笔记', '关键概念速览', '复习清单'].forEach((h) => {
      assert.ok(out.user.indexOf(h) >= 0, 'user 缺少骨架标题: ' + h);
    });
  });

  test('CourseNote', 'buildCourseNotePrompt 自定义 template 占位符被替换（无残留）', () => {
    const out = lib.buildCourseNotePrompt(cues, { title: 'X' }, { template: 'T:{{title}}\n{{transcript}}' });
    assert.ok(out.user.indexOf('{{title}}') === -1, '{{title}} 未替换');
    assert.ok(out.user.indexOf('{{transcript}}') === -1, '{{transcript}} 未替换');
  });

  // ---------- buildCourseNoteReducePrompt ----------
  test('CourseNote', 'buildCourseNoteReducePrompt 返回 {system,user} 且 system 与 map 一致', () => {
    const out = lib.buildCourseNoteReducePrompt(['A', 'B'], { title: 'T' });
    assert.strictEqual(typeof out.system, 'string');
    assert.strictEqual(typeof out.user, 'string');
    assert.deepStrictEqual(Object.keys(out).sort(), ['system', 'user']);
    assert.strictEqual(
      out.system,
      lib.buildCourseNotePrompt([], {}).system,
      'reduce 与 map 应共用同一 CHAPTER_SYSTEM_PROMPT'
    );
  });

  test('CourseNote', 'buildCourseNoteReducePrompt 多段局部笔记正确拼接（保序 + --- 分隔）', () => {
    const out = lib.buildCourseNoteReducePrompt(['PART-A', 'PART-B', 'PART-C'], { title: 'T' });
    assert.ok(out.user.indexOf('PART-A') >= 0);
    assert.ok(out.user.indexOf('PART-B') >= 0);
    assert.ok(out.user.indexOf('PART-C') >= 0);
    assert.ok(out.user.indexOf('---') >= 0, '多段应以 --- 分隔');
    assert.ok(out.user.indexOf('PART-A') < out.user.indexOf('PART-B'), '段落顺序应保持');
    assert.ok(out.user.indexOf('PART-B') < out.user.indexOf('PART-C'), '段落顺序应保持');
  });

  test('CourseNote', 'buildCourseNoteReducePrompt 单元素数组', () => {
    const out = lib.buildCourseNoteReducePrompt(['ONLY-ONE'], { title: 'T' });
    assert.ok(out.user.indexOf('ONLY-ONE') >= 0);
  });

  test('CourseNote', 'buildCourseNoteReducePrompt 空数组 / null / undefined 不抛异常', () => {
    assert.doesNotThrow(() => lib.buildCourseNoteReducePrompt([], {}));
    assert.doesNotThrow(() => lib.buildCourseNoteReducePrompt(null));
    assert.doesNotThrow(() => lib.buildCourseNoteReducePrompt(undefined));
    const out = lib.buildCourseNoteReducePrompt([]);
    assert.strictEqual(typeof out.user, 'string');
    assert.strictEqual(typeof out.system, 'string');
  });

  test('CourseNote', 'buildCourseNoteReducePrompt 字符串入参（非数组）亦被接受', () => {
    const out = lib.buildCourseNoteReducePrompt('ALREADY-JOINED', { title: 'T' });
    assert.ok(out.user.indexOf('ALREADY-JOINED') >= 0);
  });

  test('CourseNote', 'buildCourseNoteReducePrompt 含归并规则与骨架标题', () => {
    const out = lib.buildCourseNoteReducePrompt(['X'], { title: 'T' });
    ['一句话总览', '章节笔记', '关键概念速览', '复习清单'].forEach((h) => {
      assert.ok(out.user.indexOf(h) >= 0, 'reduce user 缺少骨架标题: ' + h);
    });
    assert.ok(out.user.indexOf('合并') >= 0 || out.user.indexOf('归并') >= 0, 'reduce 应含归并指令');
  });

  // ---------- buildCourseNoteMarkdown ----------
  test('CourseNote', 'buildCourseNoteMarkdown 自动补一级标题', () => {
    const out = lib.buildCourseNoteMarkdown('## 章节笔记\n内容', { title: '我的课程' });
    assert.ok(/^#\s+我的课程/.test(out), '应补齐一级标题');
    assert.ok(out.indexOf('## 章节笔记') >= 0, '正文应保留');
  });

  test('CourseNote', 'buildCourseNoteMarkdown 已有 # 开头则不重复补标题', () => {
    const body = '# 已有一级标题\n\n## 章节笔记';
    const out = lib.buildCourseNoteMarkdown(body, { title: '我的课程' });
    assert.strictEqual(out, body, '已有一级标题时应原样返回');
    const h1 = (out.match(/^#\s+/gm) || []).length;
    assert.strictEqual(h1, 1, '不应出现重复一级标题');
  });

  test('CourseNote', 'buildCourseNoteMarkdown 前置空白后 # 开头亦不重复', () => {
    const body = '\n\n# 标题\n内容';
    assert.strictEqual(lib.buildCourseNoteMarkdown(body, { title: 'X' }), body);
  });

  test('CourseNote', 'buildCourseNoteMarkdown meta 缺失时不崩（仅正文）', () => {
    assert.strictEqual(lib.buildCourseNoteMarkdown('正文内容'), '正文内容');
    assert.strictEqual(lib.buildCourseNoteMarkdown('正文内容', {}), '正文内容');
    assert.doesNotThrow(() => lib.buildCourseNoteMarkdown('正文', null));
  });

  test('CourseNote', 'buildCourseNoteMarkdown null/undefined 输入不抛且归一为字符串', () => {
    assert.doesNotThrow(() => lib.buildCourseNoteMarkdown(null, { title: 'T' }));
    assert.doesNotThrow(() => lib.buildCourseNoteMarkdown(undefined));
    assert.strictEqual(typeof lib.buildCourseNoteMarkdown(null, { title: 'T' }), 'string');
    // 无标题 + 空正文 → 空串
    assert.strictEqual(lib.buildCourseNoteMarkdown(null, {}), '');
    // 有标题 + 空正文 → 仍补齐一级标题头（head + 空 body，属预期行为）
    assert.strictEqual(lib.buildCourseNoteMarkdown(null, { title: 'T' }), '# T\n\n');
    assert.strictEqual(lib.buildCourseNoteMarkdown(undefined, { title: 'T' }), '# T\n\n');
    note('buildCourseNoteMarkdown(null,{title}) => "# T\\n\\n"（空正文仍补标题头；无标题时返回空串）');
  });

  test('CourseNote', 'buildCourseNoteMarkdown 返回值完整保留原始正文', () => {
    const body = '## 章节笔记\n### 第 1 章 · 数组（00:03）\n- 要点说明';
    const out = lib.buildCourseNoteMarkdown(body, { title: 'T' });
    assert.ok(out.indexOf(body) >= 0, '正文内容应完整保留');
  });

  test('CourseNote', 'buildCourseNoteMarkdown 标题非字符串输入被 String() 归一', () => {
    const out = lib.buildCourseNoteMarkdown('正文', { title: 12345 });
    assert.ok(/^#\s+12345/.test(out), '数字标题应转为字符串');
  });
})();

// ============================================================
// 7.5 笔记图片渲染 · Markdown 解析层（parseNoteBlocks）
// ============================================================
(function noteRenderSuite() {
  test('NoteRender', '解析 H1/H2/H3 标题层级', () => {
    const b = lib.parseNoteBlocks('# 大标题\n## 二级\n### 三级');
    assert.deepStrictEqual(b.map((x) => x.type), ['h1', 'h2', 'h3']);
    assert.strictEqual(b[0].text, '大标题');
  });

  test('NoteRender', '解析无序列表（保留加粗标记）', () => {
    const b = lib.parseNoteBlocks('- **主键**：唯一标识');
    assert.strictEqual(b[0].type, 'li');
    assert.strictEqual(b[0].text, '**主键**：唯一标识');
  });

  test('NoteRender', '解析勾选清单（已选 / 未选）', () => {
    const b = lib.parseNoteBlocks('- [ ] 待办\n- [x] 已完成');
    assert.strictEqual(b[0].type, 'check');
    assert.strictEqual(b[0].checked, false);
    assert.strictEqual(b[1].checked, true);
  });

  test('NoteRender', '解析有序列表', () => {
    const b = lib.parseNoteBlocks('1. 第一\n2. 第二');
    assert.strictEqual(b[0].type, 'oli');
    assert.strictEqual(b[0].index, '1');
  });

  test('NoteRender', '解析 Markdown 表格（表头 + 数据行）', () => {
    const b = lib.parseNoteBlocks('| 概念 | 说明 |\n| --- | --- |\n| 关系 | 二维表 |');
    assert.strictEqual(b[0].type, 'table');
    assert.deepStrictEqual(b[0].headers, ['概念', '说明']);
    assert.deepStrictEqual(b[0].rows, [['关系', '二维表']]);
  });

  test('NoteRender', '解析引用与分隔线', () => {
    const b = lib.parseNoteBlocks('> 引用内容\n\n---');
    assert.strictEqual(b[0].type, 'quote');
    assert.strictEqual(b[0].text, '引用内容');
    assert.strictEqual(b[1].type, 'hr');
  });

  test('NoteRender', '空行 / 空白输入不产生块', () => {
    assert.deepStrictEqual(lib.parseNoteBlocks(''), []);
    assert.deepStrictEqual(lib.parseNoteBlocks('\n\n   \n'), []);
  });

  test('NoteRender', 'null / undefined 输入不抛异常', () => {
    assert.deepStrictEqual(lib.parseNoteBlocks(null), []);
    assert.deepStrictEqual(lib.parseNoteBlocks(undefined), []);
  });

  test('NoteRender', '综合文档块类型顺序正确', () => {
    const md = '# T\n## S\n- a\n1. b\n- [ ] c\n| h |\n| --- |\n| v |\n> q\n---\n段落';
    const t = lib.parseNoteBlocks(md).map((x) => x.type).join(',');
    assert.strictEqual(t, 'h1,h2,li,oli,check,table,quote,hr,p');
  });
})();

// ============================================================
// 8. 红线校验（改造不得突破既有安全/结构约定）
// ============================================================
(function redlineSuite() {
  const lines = SRC_TEXT.split('\n');
  const GENERAL_TITLES = ['一句话概括', '核心观点', '内容脉络', '关键结论与行动项', '金句摘录'];

  test('Redline', '通用总结五个固定章节标题仍存在（final 默认模式）', () => {
    const p = lib.buildSummaryPrompt('[00:00:00] x', {});
    GENERAL_TITLES.forEach((t) => assert.ok(p.indexOf('## ' + t) >= 0, 'final 模式缺少章节: ' + t));
  });

  test('Redline', '通用总结五个固定章节标题仍存在（merge 模式）', () => {
    const p = lib.buildSummaryPrompt('x', { mode: 'merge' });
    GENERAL_TITLES.forEach((t) => assert.ok(p.indexOf('## ' + t) >= 0, 'merge 模式缺少章节: ' + t));
  });

  test('Redline', '源码 DEFAULT_TEMPLATE 五个固定章节标题未被改动', () => {
    GENERAL_TITLES.forEach((t) => {
      assert.ok(SRC_TEXT.indexOf('## ' + t) >= 0, '源码缺少固定章节标题: ## ' + t);
    });
    // 两条链路并存、通用链路未被章节改造污染
    assert.ok(SRC_TEXT.indexOf('function runGeneralSummary') >= 0, '通用链路 runGeneralSummary 应保留');
    assert.ok(SRC_TEXT.indexOf('function runCourseNoteSummary') >= 0, '章节链路 runCourseNoteSummary 应存在');
  });

  test('Redline', '源码 console.* 调用数量 = 0', () => {
    const n = (SRC_TEXT.match(/console\./g) || []).length;
    assert.strictEqual(n, 0, '代码中不应存在 console.* 调用，实际 ' + n + ' 处');
  });

  test('Redline', 'innerHTML 仅 2 处且均为静态用法', () => {
    const assigns = lines.filter((l) => /\.innerHTML\s*=/.test(l));
    assert.strictEqual(assigns.length, 2, 'innerHTML 赋值应恰为 2 处，实际 ' + assigns.length);
    assert.ok(assigns.some((l) => /panel\.innerHTML\s*=/.test(l)), '缺少 panel 静态骨架赋值');
    assert.ok(assigns.some((l) => /sel\.innerHTML\s*=\s*''/.test(l)), '缺少下拉清空赋值');
  });

  test('Redline', 'innerHTML 赋值行不含动态内容注入', () => {
    const assigns = lines.filter((l) => /\.innerHTML\s*=/.test(l));
    const dynNames = ['noteText', 'summaryText', 'finalText', 'partialNotes', 'partials',
      'responseText', 'choices', 'apiKey', 'Bearer'];
    assigns.forEach((l) => {
      dynNames.forEach((v) => {
        assert.ok(l.indexOf(v) === -1, 'innerHTML 赋值行疑似注入动态内容(' + v + '): ' + l.trim());
      });
    });
  });

  test('Redline', 'panel.innerHTML 多行骨架块内无动态变量拼接', () => {
    const start = lines.findIndex((l) => /panel\.innerHTML\s*=/.test(l));
    assert.ok(start >= 0, '未找到 panel.innerHTML 赋值');
    let end = start;
    while (end < lines.length && !/;\s*$/.test(lines[end])) end++;
    const block = lines.slice(start, end + 1).join('\n');
    ['noteText', 'summaryText', 'finalText', 'partialNotes', 'responseText', 'choices']
      .forEach((v) => assert.ok(block.indexOf(v) === -1, '静态骨架内出现动态内容标识: ' + v));
    // 骨架应为字符串字面量拼接，出现 `+ 变量` 即告警
    const dynConcat = /\+\s*(state|res|json|noteText|summaryText|finalText|partials|apiKey)\b/.test(block);
    assert.ok(!dynConcat, 'innerHTML 骨架存在动态变量拼接');
  });

  test('Redline', 'LLM 返回文本经 textContent 渲染（renderSummary 未被改为 innerHTML）', () => {
    assert.ok(/el\.textContent\s*=\s*text\s*\|\|\s*''/.test(SRC_TEXT), 'renderSummary 应使用 textContent');
  });

  test('Redline', 'UI 明确标注适用范围（仅总结字幕文本 / 不解析画面）', () => {
    // 该提示是产品适用范围声明，必须常驻，防止后续重构被误删
    assert.ok(/data-role="scope-notice"/.test(SRC_TEXT), '总结面板应保留适用范围提示节点 scope-notice');
    assert.ok(/字幕文本/.test(SRC_TEXT), '适用范围提示应写明「只读取字幕文本」');
    assert.ok(/画面识别/.test(SRC_TEXT), '适用范围提示应写明「不具备画面识别能力」');
    assert.ok(/访谈/.test(SRC_TEXT), '适用范围提示应点明「适用于访谈类视频」');
    assert.ok(/不会被总结到/.test(SRC_TEXT), '适用范围提示应点明 PPT 等画面内容不会被总结到');
  });
})();

// ============================================================
// 汇总输出
// ============================================================
let totalPass = 0, totalFail = 0;
console.log('\n================ QA 测试报告 ================');
console.log('模块            | 用例数 | 通过 | 失败');
console.log('--------------------------------------------');
for (const [name, b] of stats) {
  totalPass += b.pass;
  totalFail += b.fail;
  const w = (s) => String(s).padEnd(15);
  console.log(w(name) + ' | ' + String(b.pass + b.fail).padEnd(6) + ' | ' + String(b.pass).padEnd(4) + ' | ' + b.fail);
}
console.log('--------------------------------------------');
console.log('合计: ' + (totalPass + totalFail) + ' | 通过: ' + totalPass + ' | 失败: ' + totalFail);

if (failures.length) {
  console.log('\n---------- 失败明细 ----------');
  failures.forEach((f, i) => console.log((i + 1) + '. [' + f.moduleName + '] ' + f.name + '\n   → ' + f.msg));
}

if (notes.length) {
  console.log('\n---------- 观察 / 反直觉点 ----------');
  notes.forEach((n, i) => console.log((i + 1) + '. ' + n));
}

console.log('\n结果: ' + (totalFail === 0 ? 'PASS' : 'FAIL'));
process.exit(totalFail === 0 ? 0 : 1);
