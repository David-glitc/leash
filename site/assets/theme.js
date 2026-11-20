/* Black by default. The choice is remembered in this browser only. Runs in <head> so the page never flashes the wrong theme. */
(function () {
  var KEY = "leash-theme", root = document.documentElement, t = "dark";
  try { var v = localStorage.getItem(KEY); if (v === "light" || v === "dark") t = v; } catch (e) {}
  root.setAttribute("data-theme", t);
  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("theme-toggle"); if (!b) return;
    b.addEventListener("click", function () {
      var n = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      root.setAttribute("data-theme", n);
      try { localStorage.setItem(KEY, n); } catch (e) {}
    });
  });
})();
