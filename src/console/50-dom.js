  function txt(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value == null ? "" : value;
  }
  function html(id, value) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = value == null ? "" : value;
  }
  // 轮询每 2 秒重绘；内容没变时不替换 innerHTML，避免用户点击时按钮被卸载。
  function htmlIfChanged(id, value) {
    var el = document.getElementById(id);
    var next = value == null ? "" : value;
    if (el && el.innerHTML !== next) el.innerHTML = next;
  }
  function hidden(id, isHidden) {
    var el = document.getElementById(id);
    if (el) el.hidden = !!isHidden;
  }
