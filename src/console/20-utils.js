  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function n(value) {
    return Number(value || 0).toLocaleString("zh-CN");
  }
  // Minimal markdown (headings, bullets, paragraphs, inline code/bold) for the
  // bundled Release Notes. Input is escaped before any tag is emitted.
  function renderNotes(markdown) {
    function inlineText(text) {
      return esc(text)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    }
    var out = [];
    var para = [];
    var inList = false;
    function flushPara() {
      if (para.length) {
        out.push("<p>" + inlineText(para.join(" ")) + "</p>");
        para = [];
      }
    }
    function closeList() {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
    }
    String(markdown || "").split(/\r?\n/).forEach(function (line) {
      if (/^###\s+/.test(line)) {
        flushPara(); closeList();
        out.push("<h3>" + inlineText(line.replace(/^###\s+/, "")) + "</h3>");
      } else if (/^##\s+/.test(line)) {
        flushPara(); closeList();
        out.push("<h2>" + inlineText(line.replace(/^##\s+/, "")) + "</h2>");
      } else if (/^#\s+/.test(line)) {
        flushPara(); closeList();
        out.push("<h1>" + inlineText(line.replace(/^#\s+/, "")) + "</h1>");
      } else if (/^\s*[-*]\s+/.test(line)) {
        flushPara();
        if (!inList) {
          out.push("<ul>");
          inList = true;
        }
        out.push("<li>" + inlineText(line.replace(/^\s*[-*]\s+/, "")) + "</li>");
      } else if (!line.trim()) {
        flushPara(); closeList();
      } else {
        closeList();
        para.push(line.trim());
      }
    });
    flushPara();
    closeList();
    return out.join("");
  }
  function clock(ts) {
    if (!ts) return "—";
    var d = new Date(ts);
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  }
  function until(ts) {
    if (!ts) return "";
    var left = Number(ts) - Date.now();
    if (left < 0) return "苏醒";
    var d = Math.floor(left / 86400000);
    var h = Math.floor((left % 86400000) / 3600000);
    var m = Math.floor((left % 3600000) / 60000);
    var parts = [];
    if (d) parts.push(d + "d");
    if (h) parts.push(h + "h");
    if (m) parts.push(m + "m");
    if (!parts.length) return "刚苏醒";
    return parts.join(" ");
  }
  // 积分/配额到期时间的人话描述：超过一天说「N 天后」，否则说「N 小时后」。
  // 返回空串表示没有到期信息。
  function expiryText(resetAt) {
    var at = Number(resetAt);
    if (!Number.isFinite(at) || at <= 0) return "";
    var left = at - Date.now();
    if (left <= 0) return "已到期";
    var d = Math.floor(left / 86400000);
    var h = Math.floor((left % 86400000) / 3600000);
    var m = Math.floor((left % 3600000) / 60000);
    if (d >= 1) return d + " 天后到期";
    if (h >= 1) return h + " 小时后到期";
    if (m >= 1) return m + " 分钟后到期";
    return "即将到期";
  }
