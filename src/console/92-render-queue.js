  // ---- 排队切换列表 ----
  //
  // 服务端是队列的唯一权威：这里只读 state.switchQueue，所有改动都通过
  // /api/queue/* 提交后重新拉取状态渲染。免费与付费模型都可以入队。
  function queueModelInfo(id) {
    var catalog = (state && state.catalog) || [];
    var models = (state && state.models) || [];
    for (var i = 0; i < catalog.length; i++) {
      if (catalog[i] && catalog[i].id === id) return catalog[i];
    }
    for (var j = 0; j < models.length; j++) {
      if (models[j] && models[j].id === id) return models[j];
    }
    return null;
  }

  function renderQueue() {
    var queue = Array.isArray(state && state.switchQueue) ? state.switchQueue : [];
    var strategy = ((state && state.config && state.config.strategy) || "free");
    var paidOnly = strategy === "free";

    txt("queue-count", queue.length ? "· " + queue.length + " 个模型" : "");
    var runBtn = document.getElementById("queue-run");
    if (runBtn) runBtn.disabled = !queue.length;
    var clearBtn = document.getElementById("queue-clear");
    if (clearBtn) clearBtn.disabled = !queue.length;

    if (!queue.length) {
      htmlIfChanged("queue-list", "");
      hidden("queue-empty", false);
      return;
    }

    var html = "";
    queue.forEach(function (id, index) {
      var info = queueModelInfo(id);
      var name = info && info.name && info.name !== id ? '<div class="name">' + esc(info.name) + "</div>" : "";
      var provider = info && info.provider ? info.provider : (id.split("/")[0] || "");
      // 目录里找不到 = 供应商下线了，模型仍然保留在队列里（不丢用户的顺序）。
      var missing = !info;
      var isPaid = info ? info.free === false : false;
      // 完全免费策略：付费模型不参与自动切换，只能手动执行队列切换。
      var strategyNote = isPaid && paidOnly
        ? '<span class="tag blocked" title="完全免费策略下付费模型不参与自动切换，只能手动执行队列切换">策略不参与自动切换</span>'
        : isPaid
        ? '<span class="tag paid">付费</span>'
        : '<span class="tag free">免费</span>';
      html += '<div class="queue-item' + (missing ? " missing" : "") + '" data-queue-id="' + esc(id) + '">';
      html += '<span class="qi-index">' + (index + 1) + "</span>";
      html += '<div class="qi-info"><div class="id">' + esc(id) + "</div>" + name + "</div>";
      html += '<div class="qi-tags">' + strategyNote;
      if (missing) html += '<span class="tag blocked" title="该模型已不在目录中（供应商可能已下线）">已下线</span>';
      if (provider) html += '<span class="dim qi-provider">' + esc(provider) + "</span>";
      html += "</div>";
      html += '<div class="qi-actions">';
      html += '<button class="ghost" data-queue-up="' + esc(id) + '" type="button" title="上移"' + (index === 0 ? " disabled" : "") + ">↑</button>";
      html += '<button class="ghost" data-queue-down="' + esc(id) + '" type="button" title="下移"' + (index === queue.length - 1 ? " disabled" : "") + ">↓</button>";
      html += '<button class="ghost danger" data-queue-remove="' + esc(id) + '" type="button" title="从队列移除">移除</button>';
      html += "</div></div>";
    });

    htmlIfChanged("queue-list", html);
    hidden("queue-empty", true);
  }
