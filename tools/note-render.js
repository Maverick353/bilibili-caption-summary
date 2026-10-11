/**
 * 笔记图片渲染器（独立开发模块）
 * 把「章节化笔记」Markdown 渲染成一张排版精美的长图（PNG）。
 * 零依赖，纯 Canvas 2D 手绘。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NoteRender = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

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

  return {
    THEME: THEME,
    FONT: FONT,
    parseNoteBlocks: parseNoteBlocks,
    parseInline: parseInline,
    splitTimestamp: splitTimestamp,
    splitTableRow: splitTableRow,
    isTableSep: isTableSep,
    roundRect: roundRect,
    setFont: setFont,
    wrapInline: wrapInline,
    drawLines: drawLines,
    drawBlock: drawBlock,
    renderToCanvas: renderToCanvas
  };
});
