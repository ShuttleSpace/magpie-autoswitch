  function modelTier(m, activeId) {
    if (m.id === activeId) return 0; // 正在使用
    if (m.paid) return 5; // 付费 · 只读展示
    if (m.disabled) return 4; // 已禁用
    if (m.cooling) return 3; // 冷却
    if (m.preferred) return 1; // 苏醒 · 偏好
    return 2; // 苏醒
  }
  function modelTree(models, activeId, sortMode) {
    var q = filter.trim().toLowerCase();
    var list = models.filter(function (m) {
      return !q || (m.id + " " + m.provider + " " + m.name).toLowerCase().indexOf(q) >= 0;
    });
    list.sort(function (a, b) {
      if (sortMode === "priority") {
        var ta = modelTier(a, activeId);
        var tb = modelTier(b, activeId);
        if (ta !== tb) return ta - tb;
        return compareModels(a, b, "wake");
      }
      return compareModels(a, b, sortMode);
    });
    visibleIds = list.map(function (m) { return m.id; });
    return list.map(function (m) { return modelRow(m, activeId); }).join("");
  }
