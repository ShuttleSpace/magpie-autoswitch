  var state = null;
  var filter = "";
  var provSearch = "";
  var provFocus = "";
  var loading = false;
  var sortMode = "priority";
  var visibleIds = [];

  // ---- 主题：跟随系统，手动可覆盖 ----
  var THEME_KEY = "free-switch-theme";
  var themeMode = "system"; // system | light | dark
  var stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* storage may be blocked */ }
  if (stored === "light" || stored === "dark" || stored === "system") themeMode = stored;
  function applyTheme() {
    var root = document.documentElement;
    var resolved;
    if (themeMode === "system") {
      resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      resolved = themeMode;
    }
    root.setAttribute("data-theme", resolved);
    var btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.title = "当前：" + (resolved === "dark" ? "深色" : "浅色") + "（" + (themeMode === "system" ? "跟随系统" : themeMode) + "）";
    }
  }
  function saveTheme() {
    try { localStorage.setItem(THEME_KEY, themeMode); } catch { /* ignore */ }
  }
  applyTheme();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (themeMode === "system") applyTheme();
    });
  } catch { /* older browsers */ }

