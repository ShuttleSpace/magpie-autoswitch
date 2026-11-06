  function className(id, cls) {
    var el = document.getElementById(id);
    if (el) el.className = cls;
  }
  // 设置面板输入框：聚焦中的不覆盖，避免打断用户正在输入。
  function setFieldValue(id, value) {
    var el = document.getElementById(id);
    if (el && document.activeElement !== el) {
      el.value = (value === undefined || value === null) ? "" : String(value);
    }
  }
  function setFieldChecked(id, value) {
    var el = document.getElementById(id);
    if (el) el.checked = !!value;
  }
  function render() {
    if (!state) return;
    var stats = state.stats || {};
    var models = state.models || [];
    var cooling = models.filter(function (m) { return m.cooling; }).length;
    var awake = models.length - cooling;
    var preferredCount = models.filter(function (m) { return m.preferred; }).length;
    txt("s-requests", n(stats.requests));
    txt("s-switches", n(stats.switches));
    txt("s-success", n(stats.successes));
    txt("s-rate", stats.requests ? Math.round((stats.successes / stats.requests) * 100) + "%" : "");
    txt("s-exhausted", n(stats.exhausted));
    txt("s-cooling", n(cooling));
    txt("s-awake", models.length ? "/ " + n(awake) + " 苏醒" : "");
    txt("model-count", models.length ? "· " + models.length + (preferredCount ? " · " + preferredCount + " 偏好" : "") : "");

    var cfg = state.config || {};
    txt("set-version-head", state.version ? "· v" + state.version : "");
    txt("set-version", state.version || "—");
    txt("set-gateway", state.gateway || "—");
    txt("set-config", state.configFile || "—");
    txt("set-console", state.console && state.console.running ? "127.0.0.1:" + (state.console.port || "—") + " · 仅本机" : "未启动");
    txt("set-refresh", cfg.refreshSeconds ? String(cfg.refreshSeconds) : "—");
    txt("set-discovered", state.discoveredAt ? clock(state.discoveredAt) : (state.discoveryError ? "失败：" + state.discoveryError : "尚未发现"));
    txt("set-models", (Array.isArray(state.catalog) ? state.catalog.length : models.length) + " 个目录模型 · " + models.length + " 个免费");
    txt("set-first-byte", cfg.firstByteTimeoutSeconds > 0 ? cfg.firstByteTimeoutSeconds + " 秒（超时即切下一个模型）" : "已禁用");
    txt("set-upstream", "每 " + (cfg.upstreamRefreshSeconds || 20) + " 秒 · 统计窗口 " + Math.round((cfg.upstreamWindowSeconds || 900) / 60) + " 分钟 · 错误 ≥ " + (cfg.upstreamMinErrors || 2) + " 次降权");
    txt("set-max-reset", (cfg.maxResetSeconds || 1800) + " 秒");
    var strategySelect = document.getElementById("strategy");
    if (strategySelect) strategySelect.value = cfg.strategy || "free";
    var paidPolicyEl = document.getElementById("paid-policy");
    if (paidPolicyEl) paidPolicyEl.hidden = (cfg.strategy || "free") === "free";
    var paidWindowEl = document.getElementById("paid-window");
    if (paidWindowEl && document.activeElement !== paidWindowEl) paidWindowEl.value = cfg.paidWindow || "";
    var paidBalanceEl = document.getElementById("paid-min-balance");
    if (paidBalanceEl && document.activeElement !== paidBalanceEl) paidBalanceEl.value = cfg.paidMinBalance ? String(cfg.paidMinBalance) : "";

    // 设置面板：策略下拉（动态选项，与后端 STRATEGIES 同步）+ 可编辑参数
    var setStrategyEl = document.getElementById("set-strategy");
    if (setStrategyEl) {
      var labels = state.strategyLabels || {};
      if (setStrategyEl.options.length !== (state.strategies || []).length) {
        setStrategyEl.innerHTML = (state.strategies || []).map(function (s) {
          return '<option value="' + esc(s) + '">' + esc(labels[s] || s) + "</option>";
        }).join("");
      }
      if (document.activeElement !== setStrategyEl) setStrategyEl.value = cfg.strategy || "free";
    }
    setFieldValue("set-maxtries", cfg.maxTries);
    setFieldValue("set-refresh-seconds", cfg.refreshSeconds);
    setFieldValue("set-cooldown", cfg.cooldownSeconds);
    setFieldValue("set-fbto", cfg.firstByteTimeoutSeconds);
    setFieldValue("set-maxpaid", cfg.maxPaidTries);
    setFieldValue("set-paidwin", cfg.paidWindow || "");
    setFieldValue("set-minbal", cfg.paidMinBalance ? String(cfg.paidMinBalance) : "");
    setFieldChecked("set-trycooling", cfg.tryCooling !== false);
    renderUpstream();
    renderCharts();

    if (state.discoveryError) {
      className("health-dot", "dot bad");
      var healthText = document.getElementById("health-text");
      if (healthText) { healthText.textContent = "模型发现失败"; healthText.title = state.discoveryError; }
    } else {
      className("health-dot", "dot ok");
      var healthText = document.getElementById("health-text");
      if (healthText) {
        healthText.textContent = models.length ? "在线 · " + models.length + " 个免费模型" : "在线 · 未发现免费模型";
        healthText.title = "";
      }
    }

    // ---- 选择提供商（dialog）+ 已选列表（左栏）----
    var provDisabledObj = {};
    (Array.isArray(state.disabledProviders) ? state.disabledProviders : []).forEach(function (p) { provDisabledObj[p] = true; });
    var creditMap = {};
    (state.credits || []).forEach(function (c) { if (c && c.provider) creditMap[c.provider] = c; });
    var selProviders = effectiveProviders(models, state.config?.includeProviders);
    var selSet = {};
    selProviders.forEach(function (p) { selSet[p] = true; });
    var allProviders = state.allProviders || [];
    var dlgHTML = renderProviderDialogRows(allProviders, models, selSet, creditMap, provDisabledObj);
    htmlIfChanged("dlg-prov-list", dlgHTML);
    hidden("dlg-prov-empty", !!dlgHTML);
    txt("prov-count", allProviders.length ? "· " + allProviders.length : "");

    if (provFocus && !selSet[provFocus]) provFocus = "";
    // 展示目录：免费模型带 failover 状态，付费模型只读展示（不参与自动切换）
    var freeMap = {};
    models.forEach(function (m) { freeMap[m.id] = m; });
    var catalog = state.catalog || [];
    var paidCounts = {};
    catalog.forEach(function (c) { if (!c.free) paidCounts[c.provider] = (paidCounts[c.provider] || 0) + 1; });
    var allRows = catalog.map(function (c) {
      var m = freeMap[c.id];
      return m || {
        id: c.id, provider: c.provider, name: c.name, paid: !c.free, paidBlocked: c.paidBlocked ?? null,
        cooling: false, until: 0, failures: 0, lastStatus: null, lastError: null,
        reason: null, disabled: false, lastSuccessAt: null,
        context: c.context, image: c.image, toolcall: c.toolcall, reasoning: c.reasoning,
      };
    });

    var selHTML = renderSelectedProviders(selProviders, models, creditMap, provDisabledObj, paidCounts);
    htmlIfChanged("sel-prov-list", selHTML);
    hidden("sel-prov-empty", !!selHTML);
    txt("sel-count", selProviders.length ? "· " + selProviders.length : "");

    // 默认展示全部模型；点击左栏某供应商则只看它的，再点恢复
    var visibleModels = provFocus
      ? allRows.filter(function (m) { return (m.provider || "") === provFocus; })
      : allRows;
    txt("model-count", visibleModels.length
      ? "· " + visibleModels.length + (provFocus ? " · " + provFocus : "")
      : provFocus ? "· " + provFocus : "");
    var modelHTML = modelTree(visibleModels, state.activeModel ? state.activeModel.id : null, sortMode);
    var modelsEl = document.getElementById("models");
    if (modelsEl && modelsEl.innerHTML !== modelHTML) modelsEl.innerHTML = modelHTML;
    hidden("models-empty", !!modelHTML);
    if (state.activeModel && state.activeModel.id) {
      hidden("active-bar", false);
      var parts = String(state.activeModel.id).split("/");
      txt("active-provider", parts.length > 1 ? parts[0] : "");
      txt("active-model", parts.length > 1 ? parts.slice(1).join("/") : state.activeModel.id);
      txt("active-at", clock(state.activeModel.at));
    } else {
      hidden("active-bar", true);
    }
    var pendingModel = state.manualSwitch && state.manualSwitch.model ? state.manualSwitch.model : "";
    hidden("pending-bar", !pendingModel);
    if (pendingModel) txt("pending-model", pendingModel);
  }
