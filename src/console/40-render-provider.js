  function provIcon(provider) {
    var seed = 0;
    for (var i = 0; i < provider.length; i++) seed = (seed * 31 + provider.charCodeAt(i)) >>> 0;
    var emojis = ["🚀", "⚡", "🧠", "🔮", "🌟", "🔥", "💡", "⚡", "⚡", "⚡", "⚡", "⚡", "⚡", "⚡", "⚡", "⚡"];
    return emojis[seed % emojis.length];
  }
  function providerHealth(models, p) {
    var list = models.filter(function (m) { return (m.provider || "") === p; });
    var total = list.length;
    var awake = list.filter(function (m) { return !m.cooling; }).length;
    var status = total === 0 ? "down" : (awake === 0 ? "down" : (awake < total ? "degraded" : "healthy"));
    return { total: total, awake: awake, status: status, preferred: list.filter(function (m) { return m.preferred; }).length };
  }
  function effectiveProviders(models, includeProviders) {
    var freeSet = {};
    models.forEach(function (m) { if (m.provider) freeSet[m.provider] = true; });
    if (Array.isArray(includeProviders) && includeProviders.length) return includeProviders.slice();
    return Object.keys(freeSet);
  }
  function renderProviderDialogRows(allProviders, models, selectedSet, creditMap, disabledProviders) {
    var q = (provSearch || "").trim().toLowerCase();
    var parts = [];
    (allProviders || []).forEach(function (prov) {
      var p = prov.id || prov;
      var name = prov.name || p;
      if (q && (p + " " + name).toLowerCase().indexOf(q) < 0) return;
      var selected = !!selectedSet[p];
      var freeTag = providerHealth(models, p).total > 0
        ? '<span class="tag free">免费</span>'
        : '<span class="tag paid">付费</span>';
      var credit = creditMap[p];
      var hasCredits = credit && (credit.used !== undefined || credit.balance !== undefined);
      var creditText = "";
      if (hasCredits) {
        creditText = '<span class="chip-credit">积分 <b>' + (credit.used ?? 0) + "/" + (credit.total ?? 0) + "</b></span>";
      }
      var disabledMark = disabledProviders[p] ? '<span class="chip-credit">已禁用</span>' : "";
      var cls = ["dlg-item", selected ? "selected" : ""].filter(Boolean).join(" ");
      parts.push(
        '<label class="' + cls + '" data-prov="' + esc(p) + '">' +
          '<input type="checkbox" class="prov-chip-check"' + (selected ? " checked" : "") + ' data-prov-check="' + esc(p) + '">' +
          '<span class="chip-ic">' + provIcon(p) + "</span>" +
          '<span class="chip-name">' + esc(p) + "</span>" +
          freeTag +
          '<span class="chip-credit-wrap">' + creditText + disabledMark + "</span>" +
          '<button class="ghost only-btn" data-only-provider="' + esc(p) + '" type="button" title="只选这一个提供商">仅选</button>' +
        "</label>"
      );
    });
    return parts.join("");
  }
  function renderSelectedProviders(selectedIds, models, creditMap, disabledProviders, paidCounts) {
    var parts = [];
    (selectedIds || []).slice().sort().forEach(function (p) {
      var h = providerHealth(models, p);
      var credit = creditMap[p];
      var hasCredits = credit && (credit.used !== undefined || credit.balance !== undefined);
      var sub = h.total
        ? h.awake + "/" + h.total + " 苏醒" + (h.preferred ? " · " + h.preferred + " 偏好" : "") + (paidCounts && paidCounts[p] ? " · " + paidCounts[p] + " 付费" : "")
        : (paidCounts && paidCounts[p] ? paidCounts[p] + " 个付费模型" : "无模型");
      var creditText = "";
      if (hasCredits) {
        var amt = credit.balance !== undefined ? " · 余额 " + credit.balance : "";
        creditText = '<span class="prov-credit">积分 <b>' + (credit.used ?? 0) + "/" + (credit.total ?? 0) + "</b>" + amt + "</span>";
      }
      var cls = ["prov-item", h.status, provFocus === p ? "selected" : "", hasCredits ? "has-credits" : "", disabledProviders[p] ? "disabled" : ""].filter(Boolean).join(" ");
      var freeTag = h.total > 0 ? '<span class="tag free">免费</span>' : '<span class="tag paid">付费</span>';
      var creditPart = hasCredits
        ? '<span class="prov-credit">积分 <b>' + (credit.used ?? 0) + "/" + (credit.total ?? 0) + "</b>" + (credit.balance !== undefined ? " · 余额 " + credit.balance : "") + "</span>"
        : "";
      parts.push(
        '<div class="' + cls + '" data-prov="' + esc(p) + '" data-prov-filter="' + esc(p) + '" title="点击筛选该供应商的模型，再点取消">' +
          '<div class="prov-top">' +
            '<div class="prov-ic">' + provIcon(p) + "</div>" +
            '<div class="prov-name">' + esc(p) + "</div>" +
            freeTag +
            '<div class="prov-actions">' +
              (disabledProviders[p]
                ? '<button class="ghost ok" data-enable-provider="' + esc(p) + '" type="button">启用</button>'
                : '<button class="ghost danger" data-disable-provider="' + esc(p) + '" type="button">禁用</button>') +
            "</div>" +
          "</div>" +
          '<div class="prov-sub">' +
            '<span class="prov-stat"><span class="dot"></span>' + esc(sub) + "</span>" +
            creditPart +
          "</div>" +
        "</div>"
      );
    });
    return parts.join("");
  }
