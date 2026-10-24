// Fake WordPress sites for the regression suite (test/regression.js). Both
// listen on a free 127.0.0.1 port and build their pages around their own
// address, like a real site does.
const http = require("node:http");

// 40x40 PNG, so nothing is read from disk.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAMElEQVR4nO3NQQkAAAgEsAthHPtjLEsIfgb7L9P1ImKxWCwWi8VisVgsFovFYvGdBTmx1lskR8KTAAAAAElFTkSuQmCC", "base64");

async function listen(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const host = `127.0.0.1:${server.address().port}`;
  return { server, host, url: `http://${host}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

// Classic WordPress: REST API, global styles on the home page, hostile page HTML.
// Like a membership plugin, the Welcome page renders differently for a
// logged-in user (any Authorization header); `hidden` refuses anonymous REST
// requests. `requests` records [path, authenticated] for each request.
async function startWordPress({ hidden = false } = {}) {
  let B;
  const requests = [];
  const site = await listen((req, res) => {
    const u = new URL(req.url, B);
    const authed = Boolean(req.headers.authorization);
    requests.push([u.pathname, authed]);
    if (hidden && !authed && u.pathname.startsWith("/wp-json/")) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"code":"rest_cannot_access"}'); }
    const json = (v, h = {}) => { res.writeHead(200, { "content-type": "application/json", ...h }); res.end(JSON.stringify(v)); };
    if (u.pathname === "/wp-json/") return json({ name: "Bob&#8217;s Bikes", description: "Fixing bikes since 1999", namespaces: ["oembed/1.0", "wp/v2"] });
    if (u.pathname === "/wp-json/wp/v2/pages") return json(pages(authed), { "x-wp-totalpages": "1" });
    if (u.pathname === "/wp-content/uploads/a.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(home); }
    res.writeHead(404); res.end();
  });
  B = site.url;
  const pages = (authed) => [
    { id: 7, title: { rendered: "About &amp; Team" }, link: `${B}/about/`, content: { rendered: `<!-- wp:paragraph --><p class="x" style="color:red" onclick="evil()">We <strong>fix</strong> bikes. See <a href="${B}/contact/">contact</a> or <a href="/blog/post-1/">a post</a> or <a href="javascript:alert(1)">bad</a>.</p><script>alert(1)</script><div class="wp-block-group"><h1>Big</h1><iframe src="https://evil"></iframe></div><figure class="wp-block-gallery"><figure><img src="${B}/wp-content/uploads/a.png" alt="Shop" onerror="evil()"></figure><figure><img src="${B}/wp-content/uploads/missing.png"></figure></figure>` } },
    { id: 9, title: { rendered: "Contact" }, link: `${B}/contact/`, content: { rendered: `<p>Write to us</p><div class="wpcf7"><form action="/x"><input name="your-name"><button>Send</button></form></div>` } },
    { id: 3, title: { rendered: "Welcome" }, link: `${B}/`, content: { rendered: `<h2>Hello</h2><p>${authed ? "You&#8217;re already signed in." : "Sign in to your account."}</p><p>Go to <a href="/about/">about</a>.</p>` } },
  ];
  const home = `<!doctype html><html><head><style id="global-styles-inline-css">:root{--wp--preset--color--base: #fdf6e3;--wp--preset--color--contrast: #222222;--wp--preset--color--primary: #cc3300;--wp--preset--font-family--body: "Lora", Georgia, serif;}
:root :where(body){background-color: var(--wp--preset--color--base);color: var(--wp--preset--color--contrast);font-family: var(--wp--preset--font-family--body);}
a:where(:not(.wp-element-button)){color: var(--wp--preset--color--primary);}
:root :where(.wp-element-button, .wp-block-button__link){background-color: #0a7d4b;color:#fff;}</style></head>
<body class="home page-template-default page page-id-3"><img class="custom-logo" src="/wp-content/uploads/a.png"></body></html>`;
  return { ...site, requests };
}

// Elementor site: header/footer templates, a hidden mobile menu, CSS with
// url()/@import/@font-face, JSON-escaped URLs, a redirect, a 404 and a form,
// plus tracking tags and a Google Fonts stylesheet (#45). Its /css and /s/...
// routes stand in for fonts.googleapis.com and fonts.gstatic.com when a test
// points those hosts here.
// `forbidden` collects requests the copier must never make (feeds, admin).
async function startElementor() {
  let H, B;
  const forbidden = [];
  const site = await listen((req, res) => {
    const u = new URL(req.url, B);
    if (u.pathname === "/wp-json/") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ name: "Acme Ltd", description: "", namespaces: ["wp/v2"] })); }
    if (u.pathname === "/wp-json/wp/v2/pages") { res.writeHead(200, { "content-type": "application/json", "x-wp-totalpages": "1" }); return res.end("[]"); }
    if (u.pathname === "/contact/") { res.writeHead(301, { location: `${B}/contact-us/` }); return res.end(); }
    if (u.pathname.endsWith(".png") && u.pathname.includes("/uploads/")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/feed/" || u.pathname.startsWith("/wp-admin")) { forbidden.push(u.pathname); res.writeHead(500); return res.end(); }
    const body = routes()[u.pathname];
    if (body == null) { res.writeHead(404, { "content-type": "text/html" }); return res.end(page("Page not found", "<h1>Oops, nothing here</h1>")); }
    const types = { css: "text/css", js: "application/javascript", woff2: "font/woff2" };
    res.writeHead(200, { "content-type": types[u.pathname.split(".").pop()] || "text/html; charset=utf-8" });
    res.end(body);
  });
  H = site.host; B = site.url;
  const form = () => `<form class="elementor-form" method="post" name="Enquiry" action="${B}/wp-admin/admin-ajax.php" novalidate>
<input type="hidden" name="post_id" value="5"><label for="form-field-name">Your Name</label><input type="text" name="form_fields[name]" id="form-field-name" required="required">
<input type="email" name="form_fields[email]" placeholder="Email Address" aria-required="true"><textarea name="form_fields[message]" placeholder="Message"></textarea>
<label for="form-field-services">Services</label><input type="checkbox" name="form_fields[services][]" id="form-field-services-0" value="Design"><label for="form-field-services-0">Design</label><input type="checkbox" name="form_fields[services][]" id="form-field-services-1" value="Build"><label for="form-field-services-1">Build</label>
<div class="elementor-field-group" style="display:none"><input type="text" name="form_fields[other]" placeholder="Other, not required" required></div><textarea name="ak_hp_textarea" style="display:none"></textarea>
<button type="submit" class="elementor-button">Send</button></form>`;
  const menu = (title) => `<ul class="elementor-nav-menu">${[["Home", B], ["About", "/about/"], ["Contact", B + "/contact/"]].map(([t, h]) => `<li class="menu-item${t === title ? " current-menu-item" : ""}"><a href="${h}">${t}</a></li>`).join("")}</ul>`;
  const page = (title, body) => `<!doctype html><html><head><title>${title} &#8211; Acme Ltd</title><meta property="og:site_name" content="Acme Ltd">
<link rel="preconnect" href="https://fonts.gstatic.com/" crossorigin><link rel='stylesheet' id='google-fonts-1-css' href='https://fonts.googleapis.com/css?family=Sbtest%3A400&#038;display=swap' media='all'>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-OLDSITE1"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag("js",new Date());gtag("config","G-OLDSITE1");</script>
<link rel="stylesheet" href="${B}/wp-content/uploads/elementor/css/post-5.css?ver=1"><link rel="canonical" href="${B}/">
<script src="${B}/wp-includes/js/jquery/jquery.min.js?ver=3"></script>
<script>var elementorFrontendConfig = {"urls":{"assets":"http:\\/\\/${H}\\/wp-content\\/plugins\\/elementor\\/assets\\/","bundle":"http:\\/\\/${H}\\/wp-content\\/plugins\\/elementor\\/assets\\/js\\/frontend.min.js"}};</script></head>
<body class="elementor-kit-5 elementor-page"><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=123&ev=PageView&noscript=1"></noscript><div data-elementor-type="header" class="elementor elementor-location-header"><a href="${B}"><img src="${B}/wp-content/uploads/2024/01/logo.png" alt="Acme"></a>
<nav class="elementor-nav-menu--main">${menu(title)}</nav><nav class="elementor-nav-menu--dropdown" aria-hidden="true">${menu(title)}</nav><a href="/feed/">RSS</a> <a href="/wp-admin/">Admin</a> <a href="/?p=5">P</a></div>
<div data-elementor-type="wp-page" class="elementor"><section class="elementor-section"><div class="elementor-container"><div class="elementor-column"><div class="elementor-widget-wrap">
<div class="elementor-widget elementor-widget-image"><div class="elementor-widget-container"><img src="${B}/wp-content/uploads/2024/01/hero.png" srcset="${B}/wp-content/uploads/2024/01/hero.png 40w, ${B}/wp-content/uploads/2024/01/hero-2x.png 80w" alt="Hero" width="40" height="40"></div></div>
${body}
<div class="elementor-widget elementor-widget-text-editor"><div class="elementor-widget-container"><p>We make <strong>widgets</strong>.</p><p>Since 1999.</p></div></div>
<div class="elementor-widget elementor-widget-button"><a class="elementor-button" href="/contact-us/"><span class="elementor-button-content-wrapper"><span class="elementor-button-icon"><svg viewBox="0 0 1 1"></svg></span><span class="elementor-button-text">Get a quote</span></span></a></div>
</div></div></div></section></div>
<div data-elementor-type="footer" class="elementor elementor-location-footer"><p class="elementor-heading-title">Call us on 01234 567890</p></div>
<form role="search" action="/" method="get"><input name="s"><button>Search</button></form>
<script>document.addEventListener("submit", function(){ window.__elementorPosted = true; });</script></body></html>`;
  const routes = () => ({
    "/": page("Home", `<h1 class="elementor-heading-title">Welcome to Acme</h1>${form()}`),
    "/about/": page("About", `<h2>About us</h2><form class="cart" method="post" enctype="multipart/form-data"><input type="number" name="quantity" value="1"><button type="submit" name="add-to-cart" value="7">Add to basket</button></form>
<form action="${B}/wp-comments-post.php" method="post" id="commentform" class="comment-form"><textarea id="comment" name="comment" required></textarea><input id="author" name="author" required><input type="hidden" name="comment_post_ID" value="5"><input type="submit" value="Post Comment"></form>`),
    "/contact-us/": page("Contact", form()),
    "/wp-content/uploads/elementor/css/post-5.css": `@import "extra.css";\n.elementor-kit-5{--e-global-color-primary:#EE5C44;--e-global-color-secondary:#7C6BFF;--e-global-color-text:#241B2F;--e-global-color-accent:#EE5C44;--e-global-color-80f7a2e:#FFF6EE;--e-global-typography-primary-font-family:"Fraunces";--e-global-typography-text-font-family:"Plus Jakarta Sans";background-color:var( --e-global-color-80f7a2e );color:var( --e-global-color-text );}\n.elementor-section{background:url(../../2024/01/bg.png) no-repeat}\n@font-face{font-family:Acme;src:url("/wp-content/themes/hello/fonts/acme.woff2") format("woff2")}\nbody{font-family:Acme;background:#102030;color:#fff}`,
    "/wp-content/uploads/elementor/css/extra.css": `.elementor-heading-title{color:#ff9900;background-image:url(data:image/png;base64,AAAA)}`,
    "/wp-includes/js/jquery/jquery.min.js": "/* jquery */",
    "/wp-content/plugins/elementor/assets/js/frontend.min.js": `var base="${B}/wp-content/";`,
    "/wp-content/themes/hello/fonts/acme.woff2": "FONTDATA",
    "/css": "@font-face{font-family:'Sbtest';src:url(https://fonts.gstatic.com/s/sbtest/v1/a.woff2) format('woff2')}",
    "/s/sbtest/v1/a.woff2": "GOOGLEFONT",
  });
  return { ...site, forbidden };
}

// WordPress in a subfolder (/blog/) under an unrelated root site. `forbidden`
// collects requests outside the folder or into WordPress's admin.
async function startSubfolder() {
  let B;
  const forbidden = [];
  const site = await listen((req, res) => {
    const u = new URL(req.url, B);
    const html = (status, title, body) => { res.writeHead(status, { "content-type": "text/html" }); res.end(`<!doctype html><html><head><title>${title} &#8211; Sub Blog</title><meta property="og:site_name" content="Sub Blog"><link rel="https://api.w.org/" href="${B}/blog/wp-json/"></head><body>${body}</body></html>`); };
    if (u.pathname === "/blog") { res.writeHead(301, { location: `${B}/blog/` }); return res.end(); }
    if (u.pathname === "/blog/") return html(200, "Home", `<a href="${B}/blog/about/">About</a> <a href="/">Main site</a> <a href="${B}/shop/">Shop</a> <a href="${B}/blog/wp-admin/">Admin</a> <img src="${B}/blog/wp-content/uploads/a.png">`);
    if (u.pathname === "/blog/about/") return html(200, "About", `<a href="${B}/blog/">Home</a> <a href="${B}/blog/old/">Old</a>`);
    if (u.pathname === "/blog/old/") { res.writeHead(301, { location: `${B}/blog/about/` }); return res.end(); }
    if (u.pathname === "/blog/wp-content/uploads/a.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (!u.pathname.startsWith("/blog/") || u.pathname.startsWith("/blog/wp-admin")) forbidden.push(u.pathname);
    if (u.pathname.startsWith("/blog/")) return html(404, "Not found", "<h1>No such post</h1>");
    res.writeHead(404); res.end();
  });
  B = site.url;
  return { ...site, forbidden };
}

// A releases host serving latest.json for the update check (#37), so the app
// shows its "Version 99.0.0 is available" banner. Has an installer for every
// platform/arch the suite runs on.
async function startUpdates() {
  const dl = "https://github.com/PhaseN-Digital/phasen-sitebuilder-releases/releases/download/v99.0.0/";
  const latest = { version: "99.0.0", notes: dl, downloads: Object.fromEntries(["win32", "darwin", "linux"].flatMap((p) => ["x64", "arm64"].map((a) => [`${p}-${a}`, `${dl}${p}-${a}`]))) };
  const site = await listen((req, res) => {
    if (req.url !== "/latest.json") { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(latest));
  });
  return { ...site, latestUrl: `${site.url}/latest.json` };
}

// A gzipped tar like GitHub's tarballs: everything under one top folder,
// pax header for long paths. files: { "path": string|Buffer }, "dir/" for folders.
function tarball(files) {
  const zlib = require("node:zlib");
  const block = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100); h.write("0000644\0", 100); h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136); h.write("        ", 148); h.write(type, 156); h.write("ustar\0" + "00", 257);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const parts = [];
  for (const [name, body] of Object.entries({ "Acme-repo-abc123/": "", ...Object.fromEntries(Object.entries(files).map(([k, v]) => [`Acme-repo-abc123/${k}`, v])) })) {
    const data = Buffer.from(body);
    if (name.length > 99) {
      const rec = ` path=${name}\n`;
      let len = rec.length; len += String(len + String(len).length).length;
      const pax = Buffer.from(`${len}${rec}`);
      parts.push(block("pax", pax.length, "x"), pad(pax));
    }
    const dir = name.endsWith("/");
    parts.push(block(name.slice(0, 99), dir ? 0 : data.length, dir ? "5" : "0"), pad(data));
  }
  return zlib.gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

// GitHub's REST API for theme sources (#58), plus the separate download host
// its tarball endpoint redirects to. PhaseN-Digital/phasen-sitebuilder-themes
// is public; acme/private-themes answers 404 (like GitHub) unless sent
// GITHUB_TOKEN. `requests` records [host, path, authorization] for each request.
const GITHUB_TOKEN = "github_pat_fake";
const PRIVATE_FOLDER = `site/${"long-folder-name-".repeat(5)}themes`;
const themeFiles = (id, label, extra = {}) => ({
  [`${id}/theme.json`]: JSON.stringify({ label, about: `${label} test theme.`, font: '"Courier New", monospace', colors: { background: "#101010", text: "#fafafa", primary: "#ff3366", accent: "#33ccff" }, version: "1.0.0" }),
  [`${id}/theme.css`]: `/* ${id}-theme-css */ h1 { letter-spacing: 0.1em; }`,
  ...extra,
});
async function startGitHub() {
  const requests = [];
  const repos = {
    "PhaseN-Digital/phasen-sitebuilder-themes": () => ({
      "README.md": "x", ".github/workflows/ci.yml": "x",
      ...Object.fromEntries(Object.entries({ ...themeFiles("retro", "Retro", { "retro/preview.png": PNG }), ...themeFiles("clean", "Clean"), ...themeFiles("broken", "Broken", { "broken/evil.js": "alert(1)" }) }).map(([k, v]) => [`themes/${k}`, v])),
    }),
    // In a folder whose paths are too long for a plain tar header.
    "acme/private-themes": (authed) => authed && Object.fromEntries(Object.entries(themeFiles("night", "Night", { "night/preview.png": PNG })).map(([k, v]) => [`${PRIVATE_FOLDER}/${k}`, v])),
  };
  const downloads = await listen((req, res) => {
    requests.push([downloads.host, req.url, req.headers.authorization || null]);
    const files = repos[decodeURIComponent(req.url.slice(1))]?.(true);
    if (!files) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/x-gzip" });
    res.end(tarball(files));
  });
  const api = await listen((req, res) => {
    requests.push([api.host, req.url, req.headers.authorization || null]);
    const m = /^\/repos\/([^/]+\/[^/]+)\/tarball(\/.*)?$/.exec(req.url);
    if (m?.[1] === "limited/repo") { res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }); return res.end(); }
    if (!m || !repos[m[1]]?.(req.headers.authorization === `Bearer ${GITHUB_TOKEN}`)) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"message":"Not Found"}'); }
    res.writeHead(302, { location: `${downloads.url}/${encodeURIComponent(m[1])}` });
    res.end();
  });
  return { ...api, requests, token: GITHUB_TOKEN, privateSpec: `acme/private-themes/${PRIVATE_FOLDER}@main`, close: () => Promise.all([api.close(), downloads.close()]) };
}

module.exports = { startWordPress, startElementor, startSubfolder, startUpdates, startGitHub, tarball, PNG };
