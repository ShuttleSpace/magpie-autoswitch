  function compareModels(a, b, sortMode) {
    var aC = a.cooling ? 1 : 0;
    var bC = b.cooling ? 1 : 0;
    if (sortMode === "cooling") {
      // 冷却优先：冷却模型排前面，按剩余冷却时间升序（越快苏醒越靠前）
      if (aC !== bC) return bC - aC;
    } else {
      // 苏醒时间 / 按名称：冷却模型压到最后，按剩余冷却时间升序（越快苏醒越靠前）
      if (aC !== bC) return aC - bC;
    }
    // 同为冷却：按剩余冷却时间升序
    if (a.cooling && b.cooling) return (a.until || 0) - (b.until || 0);
    // 同为苏醒：按名称或最近成功时间
    if (sortMode === "name") return String(a.id).localeCompare(String(b.id));
    return (b.lastSuccessAt || 0) - (a.lastSuccessAt || 0);
  }
  function modelRow(m, activeId) {
    if (m.paid) {
      var paidName = m.name && m.name !== m.id ? '<div class="name">' + esc(m.name) + "</div>" : "";
      var strategyOn = ((state && state.config && state.config.strategy) || "free") !== "free";
      var paidBlockedTag = !strategyOn ? "" : m.paidBlocked === "window"
        ? '<span class="tag blocked" title="当前不在付费时段内，自动切换不会使用该模型">窗口外</span>'
        : m.paidBlocked === "balance"
        ? '<span class="tag blocked" title="该供应商余额低于设定的下限，自动切换不会使用该模型">余额不足</span>'
        : "";
      var paidNote = !strategyOn
        ? "不参与自动切换"
        : m.paidBlocked === "window"
        ? "不在付费时段"
        : m.paidBlocked === "balance"
        ? "余额低于下限"
        : "可自动使用（受策略限制）";
      return '<div class="model-row paid' + (m.disabled ? " disabled" : "") + '" data-model="' + esc(m.id) + '" title="付费模型：消耗该供应商的积分或余额；自动参与与否由切换策略决定">' +
        '<div class="mr-status"><span class="tag paid">付费</span>' + paidBlockedTag + "</div>" +
        '<div class="mr-model"><div class="id">' + esc(m.id) + "</div>" + paidName + "</div>" +
        '<div class="mr-fail" title="自动切换是否使用该模型">' + esc(paidNote) + "</div>" +
        '<div class="mr-action"><button class="ghost" data-switch="' + esc(m.id) + '" type="button" title="手动下次请求强制切换到该付费模型（会产生实际费用）">切换付费</button></div>' +
        "</div>";
    }
    var isActive = m.id === activeId;
    var tag = m.disabled
      ? '<span class="tag blocked">已禁用</span>'
      : isActive
      ? '<span class="tag live">使用中</span>'
      : m.cooling
      ? '<span class="tag ' + (m.reason ? "blocked" : "cooling") + '">' + (m.reason ? esc(m.reason) : esc(until(m.until))) + "</span>"
      : '<span class="tag awake">苏醒</span>';
    var last = m.lastStatus
      ? '<span class="tag ' + (m.lastStatus >= 200 && m.lastStatus < 300 ? "awake" : m.lastStatus === 429 ? "cooling" : "err") + '">' + esc(m.lastStatus) + "</span>"
      : '<span class="dim">—</span>';
    var name = m.name && m.name !== m.id ? '<div class="name">' + esc(m.name) + "</div>" : "";
    var err = m.lastError ? '<div class="name" title="' + esc(m.lastError) + '">' + esc(String(m.lastError).slice(0, 90)) + "</div>" : "";
    var preferredTag = m.preferred ? '<span class="tag pref">偏好</span>' : "";
    var upLimited = (state && state.upstream ? state.upstream.summary : []).some(function (s) { return s && s.limited && s.id === m.id; });
    var upstreamTag = upLimited ? '<span class="tag upstream" title="Magpie 网关记录到该模型近期 429/5xx，已被排到候选末尾">上游受限</span>' : "";
    var prefCheck = '<input type="checkbox" class="pref-check"' + (m.preferred ? " checked" : "") + ' data-pref="' + esc(m.id) + '" title="设为偏好模型">';
    var coolCell = m.cooling
      ? '<span class="cool-time' + (m.reason ? " over" : "") + '">' + esc(until(m.until)) + "</span>"
      : '<span class="dim">—</span>';
    var switchBtn = '<button class="ghost" data-switch="' + esc(m.id) + '" type="button" title="下次请求强制切换到该模型">切换</button>';
    var toggleBtn = m.disabled
      ? '<button class="ghost ok" data-enable="' + esc(m.id) + '" type="button">启用</button>'
      : '<button class="ghost danger" data-disable="' + esc(m.id) + '" type="button">禁用</button>';
    return '<div class="model-row' + (isActive ? " active" : "") + (m.disabled ? " disabled" : "") + '" data-model="' + esc(m.id) + '">' +
      '<div class="mr-status">' + tag + preferredTag + upstreamTag + '<span class="tag free" title="AutoSwitch 仅托管免费模型">免费</span></div>' +
      '<div class="mr-model"><div class="id">' + esc(m.id) + "</div>" + name + err + "</div>" +
      '<div class="mr-cool" title="冷却剩余时间"><span class="dim">冷却</span> ' + coolCell + "</div>" +
      '<div class="mr-last" title="最近一次请求结果">' + last + ' <span class="dim mono">' + (m.lastSuccessAt ? clock(m.lastSuccessAt) : "—") + "</span></div>" +
      '<div class="mr-fail" title="连续失败次数">失败 ' + n(m.failures) + "</div>" +
      '<div class="mr-action"><label class="pref-label" title="勾选后优先使用该模型">' + prefCheck + '</label>' + switchBtn + '<button class="ghost" data-clear="' + esc(m.id) + '" type="button">清除</button>' + toggleBtn + "</div>" +
      "</div>";
  }
