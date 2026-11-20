#!/usr/bin/env python3
"""Build the Leash documentation site from the repo's markdown into site/dist (static HTML, no framework).
Needs the `markdown` package (pip install markdown). The site and the repo docs share one source, so they cannot drift."""
from pathlib import Path
import html, os, re, shutil, sys, datetime
sys.path.insert(0, os.environ.get("MDLIB", ""))
try:
    import markdown
except ImportError:
    sys.exit("site/build.py needs the Python markdown package: pip install markdown")

ROOT = Path(__file__).resolve().parent.parent
SITE = Path(__file__).resolve().parent
DIST = SITE / "dist"
BASE = "https://leash.kierkegaard.space"
GH = "https://github.com/David-glitc/leash"
VIDEO = "https://david-film-library.pages.dev/media/leash-demo.mp4"

# slug, nav title, source file, group, description
PAGES = [
    ("overview", "Overview", "README.md", "Start", "Leash: a spending leash for AI agents on QoreChain. A classical key can only stop things."),
    ("judges", "Judge's guide", "docs/JUDGES.md", "Start", "Verify every claim about Leash in five minutes: commands, links and what is real."),
    ("getting-started", "Getting started", "docs/GETTING_STARTED.md", "Start", "Install Leash, write a leash, run the demos, deploy to the QoreChain testnet."),
    ("guarded-actions", "Guarded actions (v2)", "docs/ACTIONS.md", "Concepts", "How LeashGuardV2 lets an agent swap, wrap and use vaults while the chain enforces the owner's rate floor."),
    ("flow-language", "Flow language", "docs/FLOW_LANGUAGE.md", "Concepts", "Describe value flows in plain English; a deterministic compiler turns them into a mandate."),
    ("agents-mcp", "Agents and MCP", "mcp/README.md", "Concepts", "Use Leash from Hermes Agent, Claude Code and Cursor through the MCP server and skill."),
    ("verification", "How it is verified", "docs/VERIFICATION.md", "Trust", "Tests, invariants, mutation testing, static analysis, an attack campaign on the live guard, and read-only live verification: what each layer found."),
    ("threat-model", "Threat model", "docs/THREAT_MODEL.md", "Trust", "Who can do what, what we assume, and what stops each attack."),
    ("audit-package", "Audit package", "docs/AUDIT_PACKAGE.md", "Trust", "Scope, invariants, tests, mutation results and open questions for an auditor."),
    ("security", "Security", "SECURITY.md", "Trust", "How to report a vulnerability and what is in scope."),
    ("faq", "FAQ", "docs/FAQ.md", "Trust", "Answers to the questions we expect from judges and builders."),
    ("roadmap", "Roadmap", "docs/ROADMAP.md", "Project", "What is done, what mainnet needs, and our questions for the QoreChain team."),
    ("ai-usage", "AI usage", "AI_USAGE.md", "Project", "What the AI did, what the author decided, and where the AI was wrong."),
]
SLUG_OF = {Path(f).name: s for s, _, f, _, _ in PAGES}
SLUG_OF["ACTIONS.md"] = "guarded-actions"
SLUG_OF_PATH = {f: s for s, _, f, _, _ in PAGES}

def resolve_link(href: str, src: str) -> str:
    if re.match(r"^(https?:|mailto:|#|/)", href): return href
    path, _, frag = href.partition("#")
    if not path: return href
    target = (Path(src).parent / path).as_posix()
    target = os.path.normpath(target).replace("\\", "/")
    if target in SLUG_OF_PATH: return f"/docs/{SLUG_OF_PATH[target]}/" + (f"#{frag}" if frag else "")
    if target == "cover.png": return "/assets/cover.png"
    kind = "tree" if "." not in Path(target).name else "blob"
    return f"{GH}/{kind}/main/{target}" + (f"#{frag}" if frag else "")

def render_md(src: str) -> str:
    text = (ROOT / src).read_text()
    body = markdown.markdown(text, extensions=["tables", "fenced_code", "toc", "sane_lists"], extension_configs={"toc": {"permalink": False}})
    body = re.sub(r'(href|src)="([^"]+)"', lambda m: f'{m.group(1)}="{resolve_link(html.unescape(m.group(2)), src)}"', body)
    return body

def head(title: str, desc: str, path: str) -> str:
    t = html.escape(title); d = html.escape(desc)
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{t}</title><meta name="description" content="{d}"><link rel="canonical" href="{BASE}{path}"><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta property="og:title" content="{t}"><meta property="og:description" content="{d}"><meta property="og:type" content="website"><meta property="og:url" content="{BASE}{path}"><meta property="og:image" content="{BASE}/assets/cover.png">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="{BASE}/assets/cover.png"><meta name="color-scheme" content="dark light">
<script src="/assets/theme.js"></script><link rel="stylesheet" href="/assets/site.css"></head><body>"""

def header(active: str = "") -> str:
    def a(href, label, key): return f'<a href="{href}"{" class=on" if active == key else ""}>{label}</a>'
    return f"""<header class="top"><div class="in"><a class="brand" href="/"><img src="/assets/mark.svg" width="26" height="26" alt="">Leash</a><nav class="main">
{a("/try/", "Try it", "try")}{a("/docs/judges/", "For judges", "judges")}{a("/docs/getting-started/", "Docs", "docs")}{a("/docs/threat-model/", "Security", "sec")}{a(VIDEO, "Demo video", "v")}<a href="{GH}">GitHub</a></nav><button class="themebtn" type="button" id="theme-toggle" aria-label="Switch between dark and light theme"><svg class="moon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/></svg><svg class="sun" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button></div></header>"""

FOOT = f"""<footer>Leash is open source (Apache-2.0), unaudited, and runs on the QoreChain testnet. Built for QoreChain Build Before Q-Day.<br>
<a href="{GH}">Source</a> · <a href="/docs/judges/">Verify it yourself</a> · <a href="/llms.txt">llms.txt</a> · <a href="{GH}/blob/main/SECURITY.md">Report a vulnerability</a></footer><script src="/assets/site.js"></script></body></html>"""

def sidebar(cur: str) -> str:
    out, last = ['<aside class="side"><details class="nav" open><summary>Menu</summary>'], None
    for s, t, _, g, _ in PAGES:
        if g != last: out.append(f"<h4>{g}</h4>"); last = g
        out.append(f'<a href="/docs/{s}/"{" class=on" if s == cur else ""}>{html.escape(t)}</a>')
    out.append("</details></aside>")
    return "\n".join(out)

def doc_page(i: int) -> str:
    slug, title, src, group, desc = PAGES[i]
    body = render_md(src)
    prev = f'<a href="/docs/{PAGES[i-1][0]}/">&larr; {html.escape(PAGES[i-1][1])}</a>' if i > 0 else "<span></span>"
    nxt = f'<a href="/docs/{PAGES[i+1][0]}/">{html.escape(PAGES[i+1][1])} &rarr;</a>' if i + 1 < len(PAGES) else "<span></span>"
    edit = f'<p class="cap"><a href="{GH}/blob/main/{src}">View this page on GitHub</a> · <a href="/docs/{slug}/index.md">raw markdown</a></p>'
    sec = "judges" if slug == "judges" else ("sec" if group == "Trust" else "docs")
    return (head(f"{title} · Leash", desc, f"/docs/{slug}/") + header(sec)
            + f'<div class="docs">{sidebar(slug)}<article>{body}{edit}<div class="pn">{prev}{nxt}</div></article></div>' + FOOT)

def home() -> str:
    """The landing page is hand-authored HTML (site/landing.html); only the shared links are filled in here."""
    t = (SITE / "landing.html").read_text()
    return t.replace("%%BASE%%", BASE).replace("%%GH%%", GH).replace("%%VIDEO%%", VIDEO)

def try_page() -> str:
    body = """<main class="home"><section class="hero" style="padding-bottom:10px"><div class="tag">Interactive</div><h1 style="font-size:clamp(44px,8vw,84px)">Try Leash</h1>
<p class="lead">Compile a leash in your browser, then check the live QoreChain testnet yourself. Nothing is sent: the compiler runs locally and the verifier only reads the chain.</p></section>
<h2 class="sec">1. Write a leash in plain English</h2><p class="sub">The same deterministic compiler the CLI and the agent tools use. It refuses what it cannot read exactly, and reports every default and every gap the chain does not enforce.</p>
<div id="pg-presets" class="chips"></div><textarea id="pg-in" class="pgin" rows="4" spellcheck="false" aria-label="Leash sentence"></textarea>
<div class="cta" style="margin:10px 0 18px"><button id="pg-run" class="btn pri" type="button">Compile</button></div><div id="pg-out" class="pgout">Loading…</div>
<h2 class="sec">2. Verify the live deployment</h2><p class="sub">Twenty-two checks, read straight from the QoreChain testnet by your browser: both guards, their deployed bytecode against this source, the real transactions where <code>pqcVerify</code> accepted an ML-DSA-87 signature, five adapter actions, and a swap made by an MCP client. It is the same list <code>pnpm verify</code> runs.</p>
<p id="live-state" class="cap">Reading the guard...</p><div class="cta" style="margin:10px 0"><button id="vf-run" class="btn pri" type="button">Run the verification</button></div><div id="vf-sum" class="vsum"></div><ul id="vf-out" class="vlist"></ul>
<h2 class="sec">3. The Q-Day drill</h2><p class="sub">A leaked agent key and a leaked owner key attack the guard. The expected result is stated first. On the testnet the blocked rows are simulated calls; the rows that succeed are real transactions (linked).</p>
<h3 class="sm">Real testnet: guarded actions (15 of 15)</h3><div class="tw"><table id="dr-t2" class="dt"></table></div><h3 class="sm">Local node: every row runs against a real node (16 of 16)</h3><div class="tw"><table id="dr-l2" class="dt"></table></div>
<h2 class="sec">4. Attack campaign and test stack</h2><p class="sub">Beyond the drill: hundreds of random hostile calls against the live guard, checked by an independent oracle, plus the numbers from the other verification layers.</p><div id="stack-out" class="stats"></div><p class="cap" id="camp-note"></p>
<h2 class="sec">5. What an agent sees</h2><p class="sub">The transcript of an MCP client driving the live testnet guard: it asks which router (two are allowed for this pair), makes a real swap and wrap, and the chain refuses an over-cap swap. Click a call to expand it.</p><div id="mcp-out" class="mcp"></div>
<h2 class="sec">6. The monitor</h2><p class="sub">A burst of swaps and an unexplained outflow are each caught, and the guard is frozen by a key that can only stop things. Recorded on a local node.</p><pre id="mon-out" class="term" style="white-space:pre-wrap"></pre>
<p class="cap">Everything on this page comes from <a href="https://github.com/David-glitc/leash">the repository</a>. See the <a href="/docs/judges/">judge's guide</a> and the <a href="/docs/threat-model/">threat model</a> for what is real, what is simulated, and what is not covered.</p></main>
<script src="/assets/leash-core.js"></script><script src="/assets/try.js"></script>"""
    return (head("Try Leash: compile a leash and verify the live testnet", "Compile a leash in your browser and verify the live QoreChain testnet deployment yourself. Read-only: nothing is sent.", "/try/") + header("try") + body + FOOT)

def main():
    if DIST.exists(): shutil.rmtree(DIST)
    (DIST / "assets").mkdir(parents=True)
    for f in ("site.css", "landing.css", "landing.js", "theme.js", "site.js", "favicon.svg", "logo.svg", "mark.svg", "try.js", "leash-core.js", "verify-data.json"): shutil.copy(SITE / "assets" / f, DIST / "assets" / f)
    shutil.copytree(SITE / "assets" / "fonts", DIST / "assets" / "fonts")
    shutil.copy(ROOT / "cover.png", DIST / "assets" / "cover.png")
    (DIST / "index.html").write_text(home())
    (DIST / "try").mkdir(); (DIST / "try" / "index.html").write_text(try_page())
    today = datetime.date.today().isoformat()
    urls = [f"{BASE}/", f"{BASE}/try/"]
    for i, (slug, _, src, _, _) in enumerate(PAGES):
        d = DIST / "docs" / slug; d.mkdir(parents=True)
        (d / "index.html").write_text(doc_page(i)); shutil.copy(ROOT / src, d / "index.md")
        urls.append(f"{BASE}/docs/{slug}/")
    (DIST / "404.html").write_text(head("Not found · Leash", "Page not found", "/404") + header() + '<main class="home"><section class="hero"><h1 style="font-size:64px">Not found</h1><p class="lead">That page does not exist. <a href="/">Go home</a> or read the <a href="/docs/judges/">judge\'s guide</a>.</p></section></main>' + FOOT)
    (DIST / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {BASE}/sitemap.xml\n")
    (DIST / "sitemap.xml").write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + "".join(f"<url><loc>{u}</loc><lastmod>{today}</lastmod></url>\n" for u in urls) + "</urlset>\n")
    llms = [f"# Leash", "", "> A spending leash for AI agents on QoreChain. A classical key can only stop things; starting or loosening anything needs an ML-DSA-87 signature verified on chain by pqcVerify. Testnet only, open source (Apache-2.0), unaudited.", "",
            f"Source: {GH}", f"Demo video: {VIDEO}", "", "## Docs"] + [f"- [{t}]({BASE}/docs/{s}/index.md): {d}" for s, t, _, _, d in PAGES] + ["",
            "## Try it", f"{BASE}/try/ compiles a leash in the browser and verifies the live testnet deployment (read-only).", "", "## Verify", "`pnpm verify` (read-only, no keys) checks the live qorechain-diana deployment: guards, deployed bytecode against source, real transactions, drill reports.", "",
            "## Limits", "Testnet only; unaudited; rate floors have no price oracle; QoreSwap router address unpublished so the testnet run uses test contracts; no bridging."]
    (DIST / "llms.txt").write_text("\n".join(llms) + "\n")
    (DIST / "_headers").write_text("""/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' https://david-film-library.pages.dev; connect-src 'self' https://evm-testnet.qore.host; frame-ancestors 'none'; base-uri 'self'; form-action 'none'
/assets/*
  Cache-Control: public, max-age=3600
""")
    print(f"built {len(PAGES)} docs pages + home into {DIST}")

if __name__ == "__main__": main()
