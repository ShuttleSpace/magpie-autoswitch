  var filterEl = document.getElementById("filter");
  if (filterEl) filterEl.addEventListener("input", function (ev) {
    filter = ev.target.value || "";
    render();
  });
  var sortEl = document.getElementById("sort");
  if (sortEl) sortEl.addEventListener("change", function (ev) {
    sortMode = ev.target.value || "priority";
    render();
  });
  // 一次性提交完整付费策略，避免只改一个字段时把其余字段写回默认值。
  function paidPolicy(patch) {
    var cfg = (state && state.config) || {};
    var payload = {
      strategy: cfg.strategy || "free",
      maxPaidTries: cfg.maxPaidTries,
      paidWindow: cfg.paidWindow || null,
      paidMinBalance: cfg.paidMinBalance || 0,
    };
    for (var k in patch) payload[k] = patch[k];
    return payload;
  }
  var strategyEl = document.getElementById("strategy");
  if (strategyEl) strategyEl.addEventListener("change", function (ev) {
    action("/api/strategy", paidPolicy({ strategy: ev.target.value }));
  });
  var paidWindowInput = document.getElementById("paid-window");
  if (paidWindowInput) paidWindowInput.addEventListener("change", function (ev) {
    action("/api/strategy", paidPolicy({ paidWindow: ev.target.value.trim() || null }));
  });
  var paidBalanceInput = document.getElementById("paid-min-balance");
  if (paidBalanceInput) paidBalanceInput.addEventListener("change", function (ev) {
    var v = Number(ev.target.value);
    action("/api/strategy", paidPolicy({ paidMinBalance: Number.isFinite(v) && v > 0 ? v : 0 }));
  });
  // 对当前可见（含过滤结果）的免费模型批量设置偏好
  function bulkPref(mode) {
    var ids = visibleIds.filter(function (id) {
      return (state && state.models ? state.models : []).some(function (m) { return m.id === id; });
    });
    if (!ids.length) {
      banner("当前没有可操作的免费模型");
      return;
    }
    action("/api/preferred-bulk", { models: ids, mode: mode }, "已更新 " + ids.length + " 个可见模型的偏好", "ok");
  }
  var prefAll = document.getElementById("pref-all");
  if (prefAll) prefAll.addEventListener("click", function () { bulkPref("all"); });
  var prefInvert = document.getElementById("pref-invert");
  if (prefInvert) prefInvert.addEventListener("click", function () { bulkPref("invert"); });
  var prefNone = document.getElementById("pref-none");
  if (prefNone) prefNone.addEventListener("click", function () { bulkPref("none"); });
  var provSearchEl = document.getElementById("prov-search");
  if (provSearchEl) provSearchEl.addEventListener("input", function (ev) {
    provSearch = ev.target.value || "";
    render();
  });
  // 选择提供商 dialog：顶栏按钮打开，关闭按钮/点击遮罩关闭
