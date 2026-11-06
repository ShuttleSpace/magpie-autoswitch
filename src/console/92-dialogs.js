  var provDialog = document.getElementById("prov-dialog");
  var provPickerBtn = document.getElementById("prov-picker-btn");
  var provDialogClose = document.getElementById("prov-dialog-close");
  // dialog 打开时锁底层页面滚动，关闭（含 Esc / 点遮罩）时解锁。
  function syncScrollLock() {
    document.documentElement.classList.toggle("no-scroll", !!document.querySelector("dialog[open]"));
  }
  if (provPickerBtn && provDialog) provPickerBtn.addEventListener("click", function () { provDialog.showModal(); syncScrollLock(); });
  if (provDialogClose && provDialog) provDialogClose.addEventListener("click", function () { provDialog.close(); });
  if (provDialog) provDialog.addEventListener("close", syncScrollLock);
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
  if (upstreamBtn && upstreamDialog) upstreamBtn.addEventListener("click", function () { upstreamDialog.showModal(); syncScrollLock(); });
  if (upstreamClose && upstreamDialog) upstreamClose.addEventListener("click", function () { upstreamDialog.close(); });
  if (upstreamDialog) upstreamDialog.addEventListener("close", syncScrollLock);
  if (upstreamDialog) upstreamDialog.addEventListener("click", function (ev) {
    if (ev.target === upstreamDialog) upstreamDialog.close();
  });
  var upstreamRefreshBtn = document.getElementById("upstream-refresh");
  if (upstreamRefreshBtn) upstreamRefreshBtn.addEventListener("click", function () { action("/api/upstream", {}, "已刷新上游状态", "ok"); });

  // ---- 设置 dialog：运行信息、刷新、更新日志 ----
  var settingsDialog = document.getElementById("settings-dialog");
  var settingsBtn = document.getElementById("settings-btn");
  var settingsClose = document.getElementById("settings-close");
  if (settingsBtn && settingsDialog) settingsBtn.addEventListener("click", function () { settingsDialog.showModal(); syncScrollLock(); });
  if (settingsClose && settingsDialog) settingsClose.addEventListener("click", function () { settingsDialog.close(); });
  if (settingsDialog) settingsDialog.addEventListener("close", syncScrollLock);
  if (settingsDialog) settingsDialog.addEventListener("click", function (ev) {
    if (ev.target === settingsDialog) settingsDialog.close();
  });
  var setRefreshModels = document.getElementById("set-refresh-models");
  if (setRefreshModels) setRefreshModels.addEventListener("click", function () { action("/api/refresh"); });
  var setClearCooling = document.getElementById("set-clear-cooling");
  if (setClearCooling) setClearCooling.addEventListener("click", function () {
    if (confirm("清空所有模型的冷却时间？")) action("/api/clear", {});
  });

  // 设置面板：把编辑后的参数白名单 POST 到 /api/config。直接用 fetch 拿回
  // { ok, error, changed }，避免依赖 action() 的 banner 反馈，改用行内提示。
  async function saveConfig(payload, hintId, okText) {
    var hint = document.getElementById(hintId);
    try {
      var res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      var data = await res.json();
      state = data;
      render();
      if (hint) {
        if (data.ok === false) {
          hint.className = "set-hint err";
          hint.textContent = "保存失败：" + (data.error || "未知错误");
        } else {
          hint.className = "set-hint ok";
          hint.textContent = okText + (data.changed && data.changed.length ? "（已更新 " + data.changed.join(", ") + "）" : "（无变化）");
        }
      }
    } catch (e) {
      if (hint) {
        hint.className = "set-hint err";
        hint.textContent = "保存失败：" + (e && e.message ? e.message : e);
      }
    }
  }
  function fieldVal(id) {
    var el = document.getElementById(id);
    return el ? el.value : "";
  }
  var setStrategySave = document.getElementById("set-strategy-save");
  if (setStrategySave) setStrategySave.addEventListener("click", function () {
    var el = document.getElementById("set-strategy");
    saveConfig({ strategy: el ? el.value : "free" }, "set-strategy-hint", "策略已保存");
  });
  var setCoreSave = document.getElementById("set-core-save");
  if (setCoreSave) setCoreSave.addEventListener("click", function () {
    saveConfig({
      maxTries: fieldVal("set-maxtries"),
      refreshSeconds: fieldVal("set-refresh-seconds"),
      cooldownSeconds: fieldVal("set-cooldown"),
      firstByteTimeoutSeconds: fieldVal("set-fbto"),
    }, "set-core-hint", "核心调度参数已保存");
  });
  var setPaidSave = document.getElementById("set-paid-save");
  if (setPaidSave) setPaidSave.addEventListener("click", function () {
    var win = document.getElementById("set-paidwin");
    var bal = document.getElementById("set-minbal");
    var cooling = document.getElementById("set-trycooling");
    saveConfig({
      maxPaidTries: fieldVal("set-maxpaid"),
      paidWindow: win ? (win.value.trim() || null) : null,
      paidMinBalance: bal ? bal.value : 0,
      tryCooling: cooling ? cooling.checked : undefined,
    }, "set-paid-hint", "付费策略已保存");
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
