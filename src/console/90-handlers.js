  document.addEventListener("click", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var clear = t.closest("[data-clear]");
    if (clear) {
      ev.stopPropagation();
      action("/api/clear", { model: clear.getAttribute("data-clear") });
      return;
    }
    var dis = t.closest("[data-disable]");
    if (dis) {
      ev.stopPropagation();
      action("/api/disable", { model: dis.getAttribute("data-disable") });
      return;
    }
    var en = t.closest("[data-enable]");
    if (en) {
      ev.stopPropagation();
      action("/api/enable", { model: en.getAttribute("data-enable") });
      return;
    }
    var sw = t.closest("[data-switch]");
    if (sw) {
      ev.stopPropagation();
      var swModel = sw.getAttribute("data-switch");
      var swPaidRow = t.closest(".model-row.paid");
      if (swPaidRow) {
        if (!window.confirm("手动切换到付费模型 " + swModel + "：下次请求将强制使用该模型，可能产生实际费用。确定继续？")) return;
      }
      action("/api/switch", { model: swModel }, "已设置：下一次请求强制使用 " + swModel, "ok");
      return;
    }
    var cancelPending = t.closest("#pending-cancel");
    if (cancelPending) {
      ev.stopPropagation();
      action("/api/cancel-switch", {}, "已取消待切换", "ok");
      return;
    }
    var disProv = t.closest("[data-disable-provider]");
    if (disProv) {
      ev.stopPropagation();
      action("/api/disable", { provider: disProv.getAttribute("data-disable-provider") });
      return;
    }
    var enProv = t.closest("[data-enable-provider]");
    if (enProv) {
      ev.stopPropagation();
      action("/api/enable", { provider: enProv.getAttribute("data-enable-provider") });
      return;
    }
    var onlyProv = t.closest("[data-only-provider]");
    if (onlyProv) {
      ev.preventDefault();
      ev.stopPropagation();
      action("/api/provider", { provider: onlyProv.getAttribute("data-only-provider") });
      return;
    }
    var provFilterClick = t.closest("[data-prov-filter]");
    if (provFilterClick) {
      var pf = provFilterClick.getAttribute("data-prov-filter");
      provFocus = provFocus === pf ? "" : pf;
      render();
      return;
    }
    var provCheck = t.closest("[data-prov-check]");
    if (provCheck) {
      var provId = provCheck.getAttribute("data-prov-check");
      // 当前生效集合：includeProviders 非空用它，否则为有免费模型的全部供应商（auto）
      var base = effectiveProviders(state.models || [], state.config?.includeProviders);
      var next;
      if (provCheck.checked) {
        var cur = state.config?.includeProviders;
        next = Array.isArray(cur) && cur.length ? cur.slice() : base.slice();
        if (next.indexOf(provId) < 0) next.push(provId);
      } else {
        next = base.filter(function (p) { return p !== provId; });
      }
      action("/api/providers", { providers: next });
      return;
    }
    var themeBtn = t.closest("#theme-toggle");
    if (themeBtn) {
      if (themeMode === "system") themeMode = "light";
      else if (themeMode === "light") themeMode = "dark";
      else themeMode = "system";
      saveTheme();
      applyTheme();
    }
  });
  document.addEventListener("change", function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var pref = t.closest("[data-pref]");
    if (pref) {
      var modelId = pref.getAttribute("data-pref");
      action("/api/preferred", { model: modelId });
    }
  });
