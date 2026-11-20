/* Landing page behaviour: copy buttons, feature tabs, and the hero that runs the real Leash compiler in the browser. */
(function () {
  "use strict";
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  /* copy buttons */
  $$(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var text = b.getAttribute("data-copy") || "";
      function done() { b.classList.add("done"); setTimeout(function () { b.classList.remove("done"); }, 1400); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
      else { var t = el("textarea"); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand("copy"); done(); } catch (e) {} document.body.removeChild(t); }
    });
  });

  /* feature tabs: the first panel is already in the page, the rest live in <template>s */
  var chips = ["leash_pay · real testnet transcript", "leash_swap · real testnet transcript", "compiler · runs offline", "~/.hermes/config.yaml", "pnpm demo:monitor · local node"];
  var foots = ["pnpm mcp:live", "pnpm mcp:live:v2", "pnpm compile \"agent 0x… up to 100 USD a day, …\"", "pnpm mcp:smoke", "pnpm demo:monitor"];
  var firstPanel = $("#fv-code") ? $("#fv-code").innerHTML : "";
  var tabs = $$("[data-f]");
  function selectFeature(i) {
    tabs.forEach(function (t) { t.setAttribute("aria-selected", String(+t.getAttribute("data-f") === i)); });
    var code = $("#fv-code"); if (!code) return;
    var tpl = i === 0 ? null : document.getElementById("fv-" + i);
    code.innerHTML = i === 0 ? firstPanel : (tpl ? tpl.innerHTML : "");
    code.classList.remove("swap-in"); void code.offsetWidth; code.classList.add("swap-in");
    var chip = $("#fv-chip"); if (chip) chip.textContent = chips[i];
    var foot = $("#fv-foot"); if (foot) foot.textContent = foots[i];
    var btn = $(".feat .copy"); if (btn) btn.setAttribute("data-copy", foots[i]);
  }
  tabs.forEach(function (t) { t.addEventListener("click", function () { selectFeature(+t.getAttribute("data-f")); }); });

  /* hero: real compiler, real registry */
  var hxIn = $("#hx-in"), hxOut = $("#hx-out"), hxRun = $("#hx-run");
  if (!hxIn || !hxOut) return;
  var D = null, presets = [];
  function buildPresets(r) {
    var a = r.agent;
    return [
      "agent " + a + " up to 3 QOR a day, at most 1 QOR per payment, only to " + r.payee + " for 3 hours",
      "agent " + a + " up to 100 USD a day, at most 40 USD per payment, swap USD for ETHX on " + r.router + " at no worse than 0.00049 ETHX per USD for 5 hours",
      "agent " + a + " up to 2 QOR a day, at most 1 QOR per payment, up to 2 WQOR a day, up to 100 USD a day, at most 50 USD per payment, up to 100 VUSD a day, wrap QOR into WQOR on " + r.tokens.WQOR + ", deposit USD into vault " + r.vault + " as VUSD at no worse than 0.99 VUSD per USD for 5 hours",
      "agent " + a + " up to 100 USD a day, at most 40 USD per payment, swap USD for ETHX on " + r.router + " for 5 hours"
    ];
  }
  function registry() { var t = {}; Object.keys(D.registry.tokens).forEach(function (k) { t[k] = { address: D.registry.tokens[k], decimals: 18 }; }); return t; }
  function render(res) {
    hxOut.innerHTML = "";
    var head = el("div", "out-head");
    head.appendChild(el("span", "badge " + (res.ok ? "ok" : "bad"), res.ok ? "LEASH OK" : "LEASH REFUSED"));
    var n = { error: 0, warning: 0, gap: 0 };
    res.findings.forEach(function (f) { if (n[f.severity] != null) n[f.severity]++; });
    var parts = [];
    if (n.error) parts.push(n.error + (n.error === 1 ? " error" : " errors"));
    if (n.warning) parts.push(n.warning + (n.warning === 1 ? " warning" : " warnings"));
    if (n.gap) parts.push(n.gap + " gaps the chain does not cover");
    head.appendChild(el("span", "counts", parts.join(" · ") || "no findings"));
    hxOut.appendChild(head);
    if (res.summary) hxOut.appendChild(el("p", "out-sum", res.summary));
    var shown = res.findings.filter(function (f) { return f.severity !== "gap"; }).slice(0, 2);
    if (!shown.length) shown = res.findings.slice(0, 1);
    if (shown.length) {
      var ul = el("ul", "out-list");
      shown.forEach(function (f) { var li = el("li", f.severity); li.appendChild(el("span", "", f.severity)); li.appendChild(el("p", "", f.message)); ul.appendChild(li); });
      hxOut.appendChild(ul);
    }
    var more = el("p", "out-more"); more.appendChild(document.createTextNode("The full result, the on-chain plan and the JSON the owner signs: "));
    var a = el("a", "", "open it in Try it →"); a.href = "/try/"; more.appendChild(a); hxOut.appendChild(more);
  }
  function run() {
    if (!window.LeashCore || !D) { hxOut.textContent = "Loading the compiler…"; return; }
    try { render(window.LeashCore.compile(hxIn.value, { tokens: registry(), adapters: D.registry.adapters, guard: D.guards.v2 })); }
    catch (e) { hxOut.textContent = "Error: " + e.message; }
  }
  function pick(i) {
    $$("[data-p]").forEach(function (t) { t.setAttribute("aria-selected", String(+t.getAttribute("data-p") === i)); });
    if (presets[i]) { hxIn.value = presets[i]; run(); }
  }
  $$("[data-p]").forEach(function (t) { t.addEventListener("click", function () { pick(+t.getAttribute("data-p")); }); });
  hxRun.addEventListener("click", run);
  hxIn.addEventListener("keydown", function (e) { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run(); } });
  fetch("/assets/verify-data.json").then(function (r) { return r.json(); }).then(function (d) {
    D = d; presets = buildPresets(d.registry);
    function go() { pick(0); }
    if (window.LeashCore) go(); else window.addEventListener("load", go);
  }).catch(function () { /* the static example stays */ });
})();
