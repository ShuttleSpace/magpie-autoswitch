  async function load() {
    if (loading) return;
    loading = true;
    try {
      var res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      state = await res.json();
      render();
    } catch (e) {
      banner("控制台无法读取状态：" + (e && e.message ? e.message : e));
      className("health-dot", "dot bad");
      var healthText = document.getElementById("health-text");
      if (healthText) healthText.textContent = "连接失败";
    } finally {
      loading = false;
    }
  }
  async function action(path, body, successMessage, okKind) {
    try {
      var res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var next = await res.json();
      state = next;
      if (next && next.ok === false) {
        banner("操作失败：" + (next.error || "插件拒绝了该操作"));
      } else {
        banner(successMessage || "", okKind);
      }
      render();
    } catch (e) {
      banner("操作失败：" + (e && e.message ? e.message : e));
    }
  }
