  var bannerTimer = null;
  function banner(message, kind) {
    var el = document.getElementById("banner");
    if (!el) return;
    el.textContent = message || "";
    el.className = "banner" + (message ? " show" : "") + (message && kind === "ok" ? " ok" : "");
    if (bannerTimer) {
      clearTimeout(bannerTimer);
      bannerTimer = null;
    }
    if (message) {
      bannerTimer = setTimeout(function () { banner(""); }, 8000);
    }
  }
