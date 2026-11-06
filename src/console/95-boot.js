  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) load();
  });
  load();
  setInterval(function () { if (!document.hidden) load(); }, 2000);
