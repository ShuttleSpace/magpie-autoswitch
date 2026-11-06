// 统计图表：纯 SVG。坐标轴刻度、数值标签、图例与口径说明全部显式给出，
// 不使用双轴 / 面积堆叠 / 百分比轴，避免读图歧义。
  var CHART_COLORS = {
    success: "#7ee787",   // 成功 --green
    exhausted: "#ff6b6b", // 耗尽 --red
    aborted: "#8b98a9",   // 取消 --muted
    failure: "#ffb454",   // 其他失败 --amber
    switches: "#5eead4",  // 切换 --teal
    status: "#5eead4",
  };

  function chartTime(ts) {
    return clock(ts).slice(0, 5);
  }

  function chartEmpty(text) {
    return '<div class="chart-empty">' + esc(text) + "</div>";
  }

  function chartNiceMax(value) {
    var v = Math.max(1, Number(value) || 0);
    var step = Math.pow(10, Math.floor(Math.log10(v)));
    var scaled = v / step;
    var nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
    // 强制为 4 的倍数：4 等分后的刻度都是整数，不会出现 2/1/1/0 这种重复刻度。
    return Math.max(4, Math.ceil((nice * step) / 4) * 4);
  }

  // 通用柱状图：y 轴从 0 起、有刻度数字；每根柱顶标总数；x 轴标时间。
  function chartBars(buckets, spec) {
    var W = 620, H = 168, padL = 40, padR = 10, padT = 14, padB = 30;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var max = 0;
    buckets.forEach(function (b) { max = Math.max(max, spec.height(b)); });
    var yMax = chartNiceMax(max);
    var slot = plotW / Math.max(1, buckets.length);
    var barW = Math.max(6, Math.min(34, slot * 0.6));
    var parts = [];
    parts.push('<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(spec.label) + '">');
    // 网格线与 y 轴刻度（0 基线 + 4 等分）
    for (var t = 0; t <= 4; t++) {
      var value = Math.round((yMax / 4) * t);
      var y = padT + plotH - (plotH * t / 4);
      parts.push('<line class="chart-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>');
      parts.push('<text class="chart-tick" x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + n(value) + "</text>");
    }
    parts.push('<line class="chart-axis" x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '"/>');

    buckets.forEach(function (b, i) {
      var cx = padL + slot * (i + 0.5);
      var x = cx - barW / 2;
      var total = spec.height(b);
      var acc = 0;
      spec.segments.forEach(function (s) {
        var v = s.value(b);
        if (v <= 0) return;
        var h = (v / yMax) * plotH;
        var y = padT + plotH - acc - h;
        parts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + Math.max(0.8, h).toFixed(1) + '" fill="' + s.color + '" rx="1"><title>' +
          esc(chartTime(b.start) + "–" + chartTime(b.end) + " · " + s.name + " " + n(v) + " " + spec.unit) + "</title></rect>");
        acc += h;
      });
      if (total > 0) {
        parts.push('<text class="chart-bar-label" x="' + cx.toFixed(1) + '" y="' + (padT + plotH - acc - 4).toFixed(1) + '">' + n(total) + "</text>");
      }
      if (i === 0 || i === buckets.length - 1 || (buckets.length > 6 && i % Math.ceil(buckets.length / 4) === 0)) {
        parts.push('<text class="chart-tick" x="' + cx.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(chartTime(b.start)) + "</text>");
      }
    });
    parts.push("</svg>");
    return parts.join("");
  }

  function chartStatusBars(statuses, totalAttempts) {
    if (!statuses.length) return chartEmpty("暂无尝试记录");
    var W = 620, rowH = 26, padL = 92, padR = 62, padT = 6;
    var H = padT * 2 + statuses.length * rowH;
    var max = Math.max.apply(null, statuses.map(function (s) { return s.count; }));
    var plotW = W - padL - padR;
    var parts = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="上游 HTTP 状态分布">'];
    statuses.forEach(function (s, i) {
      var y = padT + i * rowH;
      var label = s.status === 0 ? "网络/超时 (0)" : "HTTP " + s.status;
      var w = (s.count / max) * plotW;
      var pct = totalAttempts ? Math.round((s.count / totalAttempts) * 100) : 0;
      var color = s.status === 200 ? CHART_COLORS.success : (s.status === 429 ? CHART_COLORS.failure : CHART_COLORS.exhausted);
      parts.push('<text class="chart-swatch-label" x="' + (padL - 8) + '" y="' + (y + 16) + '" text-anchor="end">' + esc(label) + "</text>");
      parts.push('<rect x="' + padL + '" y="' + (y + 5) + '" width="' + plotW + '" height="14" rx="3" fill="var(--line)"/>');
      parts.push('<rect x="' + padL + '" y="' + (y + 5) + '" width="' + Math.max(2, w).toFixed(1) + '" height="14" rx="3" fill="' + color + '"><title>' + esc(label + " " + n(s.count) + " 次，占 " + pct + "%") + "</title></rect>");
      parts.push('<text class="chart-tick" x="' + (W - 4) + '" y="' + (y + 16) + '" text-anchor="end">' + n(s.count) + " · " + pct + "%</text>");
    });
    parts.push("</svg>");
    return parts.join("");
  }

  function renderCharts() {
    var c = state && state.statsCharts;
    if (!c) return;
    var buckets = c.buckets || [];
    var hasData = c.total > 0;
    txt("charts-scope", hasData ? "· " + c.total + " 次请求 · " + chartTime(c.from) + "–" + chartTime(c.to) : "· 暂无数据");

    if (!hasData) {
      htmlIfChanged("chart-outcomes", chartEmpty("暂无请求追踪数据；发起一次请求后这里会出现图表"));
      htmlIfChanged("chart-outcomes-legend", "");
      htmlIfChanged("chart-switches", chartEmpty("暂无数据"));
      htmlIfChanged("chart-statuses", chartEmpty("暂无数据"));
      txt("chart-foot", "数据来源：插件内存中的请求追踪（最多 200 条），重启后从 traces.jsonl 恢复最近 100 条。" );
      return;
    }

    var outcomesSpec = {
      label: "请求结果按时间分桶",
      unit: "次请求",
      height: function (b) { return b.requests; },
      segments: [
        { name: "成功", color: CHART_COLORS.success, value: function (b) { return b.successes; } },
        { name: "耗尽", color: CHART_COLORS.exhausted, value: function (b) { return b.exhausted; } },
        { name: "取消", color: CHART_COLORS.aborted, value: function (b) { return b.aborted; } },
        { name: "其他失败", color: CHART_COLORS.failure, value: function (b) { return b.failures; } },
      ],
    };
    htmlIfChanged("chart-outcomes", chartBars(buckets, outcomesSpec));

    var legendParts = outcomesSpec.segments.map(function (s) {
      var total = s.name === "成功" ? c.successes : s.name === "耗尽" ? c.exhausted : s.name === "取消" ? c.aborted : c.failures;
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + " " + n(total) + "（" + Math.round(total / c.total * 100) + "%）</span>";
    }).join("");
    htmlIfChanged("chart-outcomes-legend", legendParts);

    htmlIfChanged("chart-switches", chartBars(buckets, {
      label: "切换次数按时间分桶",
      unit: "次切换",
      height: function (b) { return b.switches; },
      segments: [{ name: "切换", color: CHART_COLORS.switches, value: function (b) { return b.switches; } }],
    }));

    htmlIfChanged("chart-statuses", chartStatusBars(c.statuses || [], c.attempts));

    var minutes = c.bucketMs / 60000;
    var bucketText = minutes >= 1 ? (Math.round(minutes * 10) / 10) + " 分钟" : Math.round(c.bucketMs / 1000) + " 秒";
    txt("chart-foot",
      "样本 " + n(c.total) + " 次请求 / " + n(c.attempts) + " 次尝试，时间段 " + chartTime(c.from) + "–" + chartTime(c.to) +
      "，共 " + c.bucketCount + " 个等宽时间桶（每桶约 " + bucketText + "）。" +
      "柱高是该桶内的数量，不是累计总量；上方 5 个卡片才是累计值。" +
      "「成功 / 耗尽 / 取消 / 其他失败」互斥且相加等于请求数。" +
      "数据来源：插件内存中的最近 200 条请求追踪（重启后从 traces.jsonl 恢复 100 条），不代表全部历史。" );
  }

  var chartsToggle = document.getElementById("charts-toggle");
  if (chartsToggle) chartsToggle.addEventListener("click", function () {
    var body = document.getElementById("charts-body");
    if (!body) return;
    body.hidden = !body.hidden;
    chartsToggle.textContent = body.hidden ? "展开" : "收起";
  });
