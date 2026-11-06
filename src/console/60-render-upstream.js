  function upStatusTag(s) {
    if (s.limited) {
      return '<span class="up-tag bad">' + (s.rateLimited ? "限流 429" : "服务端错误") + " ×" + n(s.errors) + "</span>";
    }
    if (s.errors) return '<span class="up-tag warn">曾出错 ×' + n(s.errors) + "</span>";
    return '<span class="up-tag ok">正常</span>';
  }
  function renderUpstream() {
    var up = state.upstream;
    if (!up) return;
    var summary = up.summary || [];
    var limited = summary.filter(function (s) { return s.limited; });
    var stuck = up.stuck || [];
    var quotas = up.quotas || [];
    txt("upstream-badge", limited.length ? "· " + limited.length + " 受限" : (stuck.length ? "· " + stuck.length + " 卡住" : ""));
    txt("up-at", up.at ? "· " + clock(up.at) : "· 尚未读取");
    txt("up-window", Math.round((up.windowSeconds || 900) / 60));
    txt("up-limited-count", limited.length ? "· " + limited.length : "");
    txt("up-stuck-count", stuck.length ? "· " + stuck.length : "");
    hidden("upstream-error", !up.error);
    if (up.error) txt("upstream-error", "部分观测端点不可用（已降级，不影响切换）：" + up.error);

    hidden("up-limited-empty", !!limited.length);
    hidden("up-limited-table", !limited.length);
    if (limited.length) {
      htmlIfChanged("up-limited-rows", limited.map(function (s) {
        return "<tr>" +
          '<td class="up-id">' + esc(s.id) + "</td>" +
          "<td>" + upStatusTag(s) + "</td>" +
          '<td class="up-err" title="' + esc(s.lastError || "") + '">' + esc(String(s.lastError || "—").slice(0, 90)) + "</td>" +
          '<td class="up-num">' + n(s.rateLimited) + "</td>" +
          '<td class="up-num">' + n(s.serverErrors) + "</td>" +
          '<td class="up-num">' + n(s.p50Ms) + " / " + n(s.p90Ms) + "ms</td>" +
          '<td class="up-num">' + n(s.p50TtftMs) + "ms</td>" +
          '<td class="up-num">' + (s.lastErrorAt ? clock(s.lastErrorAt) : "—") + "</td>" +
          "</tr>";
      }).join(""));
    }

    hidden("up-quota-empty", !!quotas.length);
    hidden("up-quota-table", !quotas.length);
    if (quotas.length) {
      htmlIfChanged("up-quota-rows", quotas.map(function (q) {
        return "<tr>" +
          '<td class="up-id">' + esc(q.name + " / " + q.window) + "</td>" +
          '<td class="up-num">' + esc(q.remaining) + " / " + esc(q.used + q.remaining) + "</td>" +
          '<td><div class="up-meter' + (q.tight ? " tight" : "") + '"><i style="width:' + Math.max(0, Math.min(100, q.pct)) + '%"></i></div>' +
          '<span class="dim">' + n(q.pct) + "%</span></td>" +
          '<td class="up-num">' + esc(q.resetsAt ? String(q.resetsAt).slice(0, 16).replace("T", " ") : "—") + "</td>" +
          "</tr>";
      }).join(""));
    }

    hidden("up-stuck-empty", !!stuck.length);
    hidden("up-stuck-table", !stuck.length);
    if (stuck.length) {
      htmlIfChanged("up-stuck-rows", stuck.map(function (a) {
        return "<tr>" +
          '<td class="up-id">' + esc(a.model) + "</td>" +
          "<td>" + esc(a.agent) + "</td>" +
          "<td>" + esc(a.phase) + "</td>" +
          '<td class="up-num">' + esc(Math.round(a.ms / 1000) + "s") + "</td>" +
          "</tr>";
      }).join(""));
    }
  }
