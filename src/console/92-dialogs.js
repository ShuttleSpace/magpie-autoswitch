  var provDialog = document.getElementById("prov-dialog");
  var provPickerBtn = document.getElementById("prov-picker-btn");
  var provDialogClose = document.getElementById("prov-dialog-close");
  if (provPickerBtn && provDialog) provPickerBtn.addEventListener("click", function () { provDialog.showModal(); });
  if (provDialogClose && provDialog) provDialogClose.addEventListener("click", function () { provDialog.close(); });
  if (provDialog) provDialog.addEventListener("click", function (ev) {
    if (ev.target === provDialog) provDialog.close();
  });
  function allProviderIds() {
    return (state && state.allProviders ? state.allProviders : []).map(function (p) { return p.id || p; }).filter(Boolean);
  }
  var provSelectAll = document.getElementById("prov-select-all");
  if (provSelectAll) provSelectAll.addEventListener("click", function () {
    action("/api/providers", { providers: allProviderIds() });
  });
  var provInvert = document.getElementById("prov-invert");
  if (provInvert) provInvert.addEventListener("click", function () {
    var current = {};
    effectiveProviders(state.models || [], state.config && state.config.includeProviders).forEach(function (p) { current[p] = true; });
    var next = allProviderIds().filter(function (p) { return !current[p]; });
    action("/api/providers", { providers: next });
  });
  var provRefreshBtn = document.getElementById("prov-refresh");
  if (provRefreshBtn) provRefreshBtn.addEventListener("click", function () { action("/api/refresh"); });

  // ---- 上游状态 dialog ----
  var upstreamDialog = document.getElementById("upstream-dialog");
  var upstreamBtn = document.getElementById("upstream-btn");
  var upstreamClose = document.getElementById("upstream-close");
  if (upstreamBtn && upstreamDialog) upstreamBtn.addEventListener("click", function () { upstreamDialog.showModal(); });
  if (upstreamClose && upstreamDialog) upstreamClose.addEventListener("click", function () { upstreamDialog.close(); });
  if (upstreamDialog) upstreamDialog.addEventListener("click", function (ev) {
    if (ev.target === upstreamDialog) upstreamDialog.close();
  });
  var upstreamRefreshBtn = document.getElementById("upstream-refresh");
  if (upstreamRefreshBtn) upstreamRefreshBtn.addEventListener("click", function () { action("/api/upstream", {}, "已刷新上游状态", "ok"); });

  // ---- 设置 dialog：运行信息、刷新、更新日志 ----
  var settingsDialog = document.getElementById("settings-dialog");
  var settingsBtn = document.getElementById("settings-btn");
  var settingsClose = document.getElementById("settings-close");
  if (settingsBtn && settingsDialog) settingsBtn.addEventListener("click", function () { settingsDialog.showModal(); });
  if (settingsClose && settingsDialog) settingsClose.addEventListener("click", function () { settingsDialog.close(); });
  if (settingsDialog) settingsDialog.addEventListener("click", function (ev) {
    if (ev.target === settingsDialog) settingsDialog.close();
  });
  var setRefreshModels = document.getElementById("set-refresh-models");
  if (setRefreshModels) setRefreshModels.addEventListener("click", function () { action("/api/refresh"); });
  var setClearCooling = document.getElementById("set-clear-cooling");
  if (setClearCooling) setClearCooling.addEventListener("click", function () {
    if (confirm("清空所有模型的冷却时间？")) action("/api/clear", {});
  });
  var notesBtn = document.getElementById("release-notes-btn");
  var notesEl = document.getElementById("release-notes");
  var notesLoaded = false;
  if (notesBtn && notesEl) notesBtn.addEventListener("click", async function () {
    notesEl.hidden = !notesEl.hidden;
    notesBtn.textContent = notesEl.hidden ? "查看 Release Notes" : "收起 Release Notes";
    if (notesEl.hidden || notesLoaded) return;
    notesLoaded = true;
    notesEl.textContent = "加载中…";
    try {
      var res = await fetch("/api/release-notes", { cache: "no-store" });
      var data = await res.json();
      notesEl.innerHTML = renderNotes(data && data.notes ? data.notes : "暂无更新日志");
    } catch (e) {
      notesEl.textContent = "读取失败：" + (e && e.message ? e.message : e);
    }
  });
  // 拖拽分隔条调整左右栏宽度
