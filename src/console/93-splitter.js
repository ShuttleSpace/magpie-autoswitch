  (function setupSplitter() {
    var splitter = document.getElementById("splitter");
    var grid = document.getElementById("grid2");
    if (!splitter || !grid) return;
    var dragging = false;
    function onMove(ev) {
      if (!dragging) return;
      var rect = grid.getBoundingClientRect();
      var x = ev.clientX - rect.left;
      var pct = (x / rect.width) * 100;
      pct = Math.max(18, Math.min(72, pct));
      grid.style.setProperty("--prov-w", pct + "%");
    }
    function onUp() {
      dragging = false;
      splitter.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    splitter.addEventListener("mousedown", function (ev) {
      dragging = true;
      splitter.classList.add("dragging");
      ev.preventDefault();
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  })();
