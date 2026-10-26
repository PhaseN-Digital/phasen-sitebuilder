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
// Members and Cart pages only work on WordPress (#56).
// Like a membership plugin, the Welcome page renders differently for a
// logged-in user (any Authorization header); `hidden` refuses anonymous REST
// requests. `requests` records [path, authenticated] for each request.
// Ownership verification (#141): /wp/v2/users/me only accepts admin's
// application password ("admin", "abcd efgh"), and with `verifyToken` the site serves
// /phasen-verify-<token>.txt ("any": for whatever token the app's dialog made up).
async function startWordPress({ hidden = false, verifyToken } = {}) {
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
    if (u.pathname === "/wp-json/wp/v2/users/me") {
      if (req.headers.authorization === `Basic ${Buffer.from("admin:abcdefgh").toString("base64")}`) return json({ id: 1, name: "admin" });
      res.writeHead(401, { "content-type": "application/json" }); return res.end('{"code":"rest_not_logged_in"}');
    }
    const token = /^\/phasen-verify-([a-f0-9]+)\.txt$/.exec(u.pathname)?.[1];
    if (token && (verifyToken === "any" || token === verifyToken)) { res.writeHead(200, { "content-type": "text/plain" }); return res.end(`${token}\n`); }
    if (u.pathname === "/wp-content/uploads/a.png") { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(home); }
    res.writeHead(404); res.end();
  });
  B = site.url;
  const pages = (authed) => [
    { id: 7, title: { rendered: "About &amp; Team" }, link: `${B}/about/`, content: { rendered: `<!-- wp:paragraph --><p class="x" style="color:red" onclick="evil()">We <strong>fix</strong> bikes. See <a href="${B}/contact/">contact</a> or <a href="/blog/post-1/">a post</a> or <a href="javascript:alert(1)">bad</a>.</p><script>alert(1)</script><div class="wp-block-group"><h1>Big</h1><iframe src="https://evil"></iframe></div><figure class="wp-block-gallery"><figure><img src="${B}/wp-content/uploads/a.png" alt="Shop" onerror="evil()"></figure><figure><img src="${B}/wp-content/uploads/missing.png"></figure></figure>` } },
    { id: 9, title: { rendered: "Contact" }, link: `${B}/contact/`, content: { rendered: `<p>Write to us</p><div class="wpcf7"><form action="/x"><input name="your-name"><button>Send</button></form></div>` } },
    // WordPress-only pages the editable import skips (#56): one known by its form, one by its title and shortcode output.
    { id: 11, title: { rendered: "Members" }, link: `${B}/members/`, content: { rendered: `<p>Members only.</p><form name="loginform" method="post" action="${B}/wp-login.php"><input name="log"><input type="password" name="pwd"><button>Log in</button></form>` } },
    { id: 12, title: { rendered: "Cart" }, link: `${B}/cart/`, content: { rendered: `<div class="woocommerce"><form class="woocommerce-cart-form" method="post"><input name="cart[abc][qty]" value="1"><button name="update_cart">Update</button></form></div>` } },
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
// plus tracking tags and a Google Fonts stylesheet (#45), and a header logo
// and CSS background under /assets/, like phasen.digital (#163). Its /css and /s/...
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
    if (u.pathname.endsWith(".png") && (u.pathname.includes("/uploads/") || u.pathname.startsWith("/assets/"))) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (u.pathname === "/feed/" || u.pathname.startsWith("/wp-admin")) { forbidden.push(u.pathname); res.writeHead(500); return res.end(); }
    const body = routes()[u.pathname];
    if (body == null) { res.writeHead(404, { "content-type": "text/html" }); return res.end(page("Page not found", "<h1>Oops, nothing here</h1>")); }
    const types = { css: "text/css", js: "application/javascript", woff2: "font/woff2", txt: "text/plain", xml: "application/xml" };
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
<link rel="stylesheet" href="${B}/wp-content/uploads/elementor/css/post-5.css?ver=1"><link rel="canonical" href="${B}/"><meta property="og:url" content="https://acme.example/${title === "Home" ? "" : title.toLowerCase() + "/"}"><meta property="og:image" content="${B}/wp-content/uploads/2024/01/hero.png"><meta name="twitter:image" content="https://cdn.example/x.png">
<script src="${B}/wp-includes/js/jquery/jquery.min.js?ver=3"></script>
<script>var elementorFrontendConfig = {"urls":{"assets":"http:\\/\\/${H}\\/wp-content\\/plugins\\/elementor\\/assets\\/","bundle":"http:\\/\\/${H}\\/wp-content\\/plugins\\/elementor\\/assets\\/js\\/frontend.min.js"}};</script></head>
<body class="elementor-kit-5 elementor-page"><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=123&ev=PageView&noscript=1"></noscript><div data-elementor-type="header" class="elementor elementor-location-header"><a href="${B}"><img src="${B}/wp-content/uploads/2024/01/logo.png" alt="Acme"></a><span class="brand"><img src="/assets/logo-wide.png" class="brand-logo" alt="Acme Ltd"></span>
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
    "/wp-content/uploads/elementor/css/post-5.css": `@import "extra.css";\n.elementor-kit-5{--e-global-color-primary:#EE5C44;--e-global-color-secondary:#7C6BFF;--e-global-color-text:#241B2F;--e-global-color-accent:#EE5C44;--e-global-color-80f7a2e:#FFF6EE;--e-global-typography-primary-font-family:"Fraunces";--e-global-typography-text-font-family:"Plus Jakarta Sans";background-color:var( --e-global-color-80f7a2e );color:var( --e-global-color-text );}\n.elementor-section{background:url(../../2024/01/bg.png) no-repeat}\n.brand{display:inline-block;width:8px;height:8px;background:url(/assets/brand-bg.png)}\n@font-face{font-family:Acme;src:url("/wp-content/themes/hello/fonts/acme.woff2") format("woff2")}\nbody{font-family:Acme;background:#102030;color:#fff}`,
    "/wp-content/uploads/elementor/css/extra.css": `.elementor-heading-title{color:#ff9900;background-image:url(data:image/png;base64,AAAA)}`,
    "/wp-includes/js/jquery/jquery.min.js": "/* jquery */",
    "/wp-content/plugins/elementor/assets/js/frontend.min.js": `var base="${B}/wp-content/";`,
    "/wp-content/themes/hello/fonts/acme.woff2": "FONTDATA",
    "/css": "@font-face{font-family:'Sbtest';src:url(https://fonts.gstatic.com/s/sbtest/v1/a.woff2) format('woff2')}",
    "/s/sbtest/v1/a.woff2": "GOOGLEFONT",
    "/robots.txt": `User-agent: *\nDisallow: /wp-admin/\n\nSitemap: ${B}/sitemap_index.xml\nSitemap: https://other.example/s.xml\n`,
    "/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//${H}/main-sitemap.xsl"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${B}/</loc><lastmod>2024-01-01</lastmod></url>\n<url><loc>${B}/about/</loc></url>\n<url><loc>${B}/old-post/</loc></url>\n</urlset>\n`,
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

// Non-WordPress sites for the editable import of any website (#161):
// "semantic" uses <header>/<nav>/<main>/<footer>; "soup" is all divs (the
// Readability path), with .html addresses, a menu order unlike the crawl's, an
// "extra" block Readability leaves out (the regression flow picks the wider
// block instead) and a contact form; "sidebar" has a sidebar and a cookie
// banner beside its content, neither of which may be imported. Every page's
// chrome includes CHROME_MARKER, which must never reach imported content.
const CHROME_MARKER = "Chrome marker 77";
async function startPlainSite(kind) {
  const para = (topic) => `<p>${topic} is what we are known for in town. ${"Fresh ingredients, careful cooking and friendly service every single day of the week. ".repeat(3)}</p>`;
  const pages = {
    semantic: {
      "/": ["Home", `<h1>Welcome to Landmark Ltd</h1>${para("Consulting")}<p>See <a href="/services/">our services</a>.</p>`],
      "/services/": ["Services", `<h1>Services</h1>${para("Advice")}<img src="/img/photo.png" alt="Office">`],
      "/about/": ["About", `<h1>About</h1>${para("History")}`],
    },
    soup: {
      "/": ["Home", `<div class="big">Soup Co kitchen</div>${para("Soup")}<div><img src="/img/photo.png" alt="Bowl"></div><p>Read <a href="/menu.html">our menu</a>, <a href="/old-news.html">old news</a> or <a href="https://elsewhere.example/x">a review</a>.</p>`],
      "/old-news.html": ["Old news", `<div class="big">We moved</div>${para("Moving")}`],
      "/menu.html": ["Our menu", `<div class="big">The menu</div>${para("Tomato soup")}<p><b>Leek</b> and <i>potato</i>.</p>`],
      "/visit.html": ["Visit us", `<div class="big">Find us</div>${para("Our cafe")}`, `<div class="extra">Opening hours: 9 to 5, Monday to Saturday.</div>`],
    },
    sidebar: {
      "/": ["Home", `<h2>Side Street news</h2>${para("Printing")}`],
      "/work/": ["Work", `<h2>Our work</h2>${para("Posters")}`],
    },
  }[kind];
  const nav = { semantic: ["/", "/services/", "/about/"], soup: ["/", "/visit.html", "/menu.html"], sidebar: ["/", "/work/"] }[kind];
  const links = nav.map((p) => `<a href="${p}">${pages[p][0]}</a>`).join(" ");
  const cookie = `<div class="cookie-notice"><p>We use cookies to make this website work and to understand how it is used, ${CHROME_MARKER}.</p><button>Accept</button></div>`;
  const body = (p) => {
    const [, content, extra = ""] = pages[p];
    if (kind === "semantic") return `<header><img src="/img/logo.png" alt="Landmark logo"><nav>${links}</nav></header><main>${content}</main><footer>${CHROME_MARKER} Landmark Ltd</footer>`;
    if (kind === "soup") return `<div class="top"><div class="brand"><img src="/img/logo.png" alt="Soup Co"></div><div class="links">${links}</div></div><div class="wrap"><div class="col-a"><div class="txt">${content}</div>${extra}</div></div><div class="bottom">${CHROME_MARKER}: 1 High Street. <form method="post" action="/subscribe"><label for="e">Your email</label><input type="email" id="e" name="email" required><button>Join</button></form></div>`;
    return `<div class="masthead"><div class="menu">${links}</div></div><div class="layout"><div class="post">${content}</div><div class="side-col">Recent posts and archives from Side Street, ${CHROME_MARKER}, plus a tag cloud, links to friends and our printing price list.</div></div>${cookie}`;
  };
  const site = await listen((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname.startsWith("/img/")) { res.writeHead(200, { "content-type": "image/png" }); return res.end(PNG); }
    if (!pages[u.pathname]) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<h1>Not found</h1>"); }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>${pages[u.pathname][0]} | ${kind} site</title><meta property="og:site_name" content="${kind} site"><style>body{background:#fdf6e3;color:#222222;font-family:Georgia,serif}a{color:#cc3300}button{background:#0a7d4b;color:#fff}</style></head><body>${body(u.pathname)}</body></html>`);
  });
  return site;
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
  const writer = await gitRepos();
  const api = await listen(async (req, res) => {
    requests.push([api.host, req.url, req.headers.authorization || null]);
    if (await writer.handle(req, res)) return;
    const m = /^\/repos\/([^/]+\/[^/]+)\/tarball(\/.*)?$/.exec(req.url);
    if (m?.[1] === "limited/repo") { res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }); return res.end(); }
    // Like GitHub: a bad token is refused even for a public repo.
    if (m && req.headers.authorization && req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) { res.writeHead(401, { "content-type": "application/json" }); return res.end('{"message":"Bad credentials"}'); }
    if (!m || !repos[m[1]]?.(req.headers.authorization === `Bearer ${GITHUB_TOKEN}`)) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"message":"Not Found"}'); }
    res.writeHead(302, { location: `${downloads.url}/${encodeURIComponent(m[1])}` });
    res.end();
  });
  return { ...api, ...writer.state, requests, token: GITHUB_TOKEN, privateSpec: `acme/private-themes/${PRIVATE_FOLDER}@main`, close: () => Promise.all([api.close(), downloads.close()]) };
}

// The writing half of the fake GitHub (#60), served by startGitHub's API host:
// the device flow (/login/... , "pending" once, then GITHUB_TOKEN for the user
// "octo"), /user, and tiny in-memory repos with the git data API, forks and PRs.
// Trees are flat { path: blob sha }. Only GITHUB_TOKEN is accepted for anything
// but the login endpoints. state: { logins: [{ client_id, scope }], pulls,
// files(repo, branch) -> { path: Buffer } }.
const CLIENT_ID = "Iv1.fakeclient";
async function gitRepos() {
  const sha = (v) => require("node:crypto").createHash("sha1").update(JSON.stringify(v)).digest("hex");
  const blobs = {}, trees = {}, commits = {};
  const commit = (tree, parents, message) => { const c = { tree, parents, message }; const s = sha(c); commits[s] = c; return s; };
  const repo = (files, opts) => {
    const tree = {};
    for (const [p, v] of Object.entries(files)) { const b = Buffer.from(v); const s = sha(b.toString("base64")); blobs[s] = b; tree[p] = s; }
    const t = sha(tree); trees[t] = tree;
    return { default_branch: "main", private: false, push: true, refs: { main: commit(t, [], "init") }, ...opts };
  };
  const repos = {
    "PhaseN-Digital/phasen-themes-private": repo({ "README.md": "x", "themes/.gitkeep": "" }, { private: true }),
    "PhaseN-Digital/phasen-sitebuilder-themes": repo({ "README.md": "x", "themes/clean/theme.css": "x" }, { push: false }),
    "octo/readonly": repo({ "README.md": "x" }, { push: false }),
  };
  const logins = [], pulls = [];
  let polls = 0;
  const files = (name, branch = "main") => {
    const tree = trees[commits[repos[name].refs[branch]].tree];
    return Object.fromEntries(Object.entries(tree).map(([p, s]) => [p, blobs[s]]));
  };
  const handle = async (req, res) => {
    const u = new URL(req.url, "http://x");
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const send = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); return true; };
    if (req.method === "POST" && u.pathname === "/login/device/code") {
      const p = Object.fromEntries(new URLSearchParams(raw));
      logins.push(p);
      if (p.client_id !== CLIENT_ID) return send(200, { error: "unauthorized_client" });
      return send(200, { device_code: "dev-code", user_code: "WDJB-MJHT", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 });
    }
    if (req.method === "POST" && u.pathname === "/login/oauth/access_token") {
      const p = Object.fromEntries(new URLSearchParams(raw));
      if (p.device_code !== "dev-code" || p.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") return send(200, { error: "incorrect_device_code" });
      return send(200, polls++ % 2 === 0 ? { error: "authorization_pending" } : { access_token: GITHUB_TOKEN, token_type: "bearer", scope: logins.at(-1)?.scope });
    }
    const body = raw ? JSON.parse(raw) : {};
    const authed = req.headers.authorization === `Bearer ${GITHUB_TOKEN}`;
    if (u.pathname === "/user") return authed ? send(200, { login: "octo" }) : send(401, { message: "Bad credentials" });
    const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(u.pathname);
    const r = m && repos[m[1]];
    const rest = m?.[2] || "";
    if (!r || (r.private && !authed) || rest.startsWith("/tarball")) return false; // the theme-source half answers
    if (!authed && req.method !== "GET") return send(401, { message: "Requires authentication" });
    const nope = () => send(403, { message: "Resource not accessible by integration" });
    if (req.method === "GET" && !rest) return send(200, { full_name: m[1], default_branch: r.default_branch, private: r.private, permissions: { push: authed && r.push } });
    let x;
    if (req.method === "GET" && (x = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) return r.refs[x[1]] ? send(200, { object: { sha: r.refs[x[1]] } }) : send(404, { message: "Not Found" });
    if (req.method === "GET" && (x = /^\/git\/commits\/(\w+)$/.exec(rest))) return send(200, { sha: x[1], tree: { sha: commits[x[1]].tree } });
    if (req.method === "POST" && rest === "/forks") {
      const name = `octo/${m[1].split("/")[1]}`;
      repos[name] ||= { ...r, push: true, private: false, refs: { ...r.refs }, parent: m[1] };
      return send(202, { full_name: name, owner: { login: "octo" } });
    }
    if (!r.push) return nope();
    if (req.method === "POST" && rest === "/merge-upstream") { r.refs[body.branch] = repos[r.parent].refs[body.branch]; return send(200, {}); }
    if (req.method === "POST" && rest === "/git/blobs") { const b = Buffer.from(body.content, "base64"); const s = sha(body.content); blobs[s] = b; return send(201, { sha: s }); }
    if (req.method === "POST" && rest === "/git/trees") {
      const tree = { ...trees[body.base_tree] };
      for (const e of body.tree) { if (!blobs[e.sha] || e.mode !== "100644") return send(422, { message: "bad tree entry" }); tree[e.path] = e.sha; }
      const t = sha(tree); trees[t] = tree; return send(201, { sha: t });
    }
    if (req.method === "POST" && rest === "/git/commits") return send(201, { sha: commit(body.tree, body.parents, body.message) });
    if (req.method === "PATCH" && (x = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      if (!commits[body.sha]?.parents.includes(r.refs[x[1]])) return send(422, { message: "Update is not a fast forward" });
      r.refs[x[1]] = body.sha; return send(200, {});
    }
    if (req.method === "POST" && rest === "/git/refs") { r.refs[body.ref.replace("refs/heads/", "")] = body.sha; return send(201, {}); }
    return send(404, { message: "Not Found" });
  };
  // PRs go to the public repo, which the user can't push to, so before handle()'s push check.
  return { handle: async (req, res) => {
    if (req.method === "POST" && req.url === "/repos/PhaseN-Digital/phasen-sitebuilder-themes/pulls") {
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const [owner, branch] = body.head.split(":");
      if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}` || !repos[`${owner}/phasen-sitebuilder-themes`]?.refs[branch]) { res.writeHead(422); res.end("{}"); return true; }
      pulls.push({ ...body, files: files(`${owner}/phasen-sitebuilder-themes`, branch) });
      res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ number: pulls.length, html_url: `https://github.com/PhaseN-Digital/phasen-sitebuilder-themes/pull/${pulls.length}` }));
      return true;
    }
    return handle(req, res);
  }, state: { logins, pulls, files, clientId: CLIENT_ID } };
}

// Cloudflare's zone list (lib/publish.js listZones) as a fetch stand-in, for
// ownership verification by zone (#141). Other requests go to `next`.
const cloudflareZones = (zones, next = globalThis.fetch) => async (url, opts) => (String(url).startsWith("https://api.cloudflare.com/client/v4/zones?")
  ? { status: 200, json: async () => ({ success: true, result: zones.map((name, i) => ({ id: `zone${i}`, name })) }) }
  : next(url, opts));

// Resend's send endpoint for a built Worker (#218): accepts only the keys the
// app's fake issued (test/legacy.js), records every email it was asked to send.
async function startResend() {
  const sent = [];
  const site = await listen((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const key = (req.headers.authorization || "").replace("Bearer ", "");
      const ok = /^re_(full|send_\d+)$/.test(key);
      sent.push({ key, ok, ...JSON.parse(body || "{}") });
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(JSON.stringify(ok ? { id: `email-${sent.length}` } : { statusCode: 401, name: "validation_error", message: "API key is invalid" }));
    });
  });
  return { ...site, sent };
}

// GitHub for site/settings sync (#137): POST /user/repos and /orgs/<org>/repos
// make an empty bare repo, and /<owner>/<repo>.git is real git smart HTTP via
// `git http-backend`. Only Basic auth with GITHUB_TOKEN as the password gets in.
// Anything else (device flow sign-in, /user) is gitRepos()'s.
// state: repos (owner/repo -> bare dir), git(spec, ...args) runs git on one.
async function startGitHost() {
  const { execFileSync, spawn } = require("node:child_process");
  const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-githost-"));
  const repos = new Map(), requests = [], writer = await gitRepos();
  const git = (spec, ...args) => execFileSync("git", ["-C", repos.get(spec), ...args], { encoding: "utf8" });
  const host = await listen(async (req, res) => {
    const auth = req.headers.authorization || "";
    requests.push([req.method, req.url, auth || null]);
    const send = (status, v) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const m = /^\/(?:user|orgs\/([^/]+))\/repos$/.exec(req.url);
    if (req.method === "POST" && m) {
      if (auth !== `Bearer ${GITHUB_TOKEN}`) return send(401, { message: "Bad credentials" });
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const spec = `${m[1] || "octo"}/${body.name}`;
      if (repos.has(spec)) return send(422, { message: "Repository creation failed." });
      repos.set(spec, path.join(root, spec));
      execFileSync("git", ["init", "-q", "--bare", "-b", "main", repos.get(spec)]);
      git(spec, "config", "http.receivepack", "true");
      return send(201, { full_name: spec, private: body.private });
    }
    const g = /^\/([^/]+\/[^/]+?)\.git(\/[^?]*)(?:\?(.*))?$/.exec(req.url);
    const basic = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString().split(":")[1] : null;
    if (!g) return (await writer.handle(req, res)) || send(404, { message: "Not Found" });
    if (!repos.has(g[1])) { res.writeHead(404); return res.end(); }
    if (basic !== GITHUB_TOKEN) { res.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' }); return res.end(); }
    const cgi = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: "octo", PATH_INFO: `/${g[1]}${g[2]}`, QUERY_STRING: g[3] || "", REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers["content-type"] || "", GIT_PROTOCOL: req.headers["git-protocol"] || "" } });
    req.pipe(cgi.stdin);
    const out = []; cgi.stdout.on("data", (c) => out.push(c));
    cgi.on("close", () => {
      const buf = Buffer.concat(out), end = buf.indexOf("\r\n\r\n");
      const headers = {}; let status = 200;
      for (const line of buf.slice(0, end).toString().split("\r\n")) {
        const [k, ...v] = line.split(":");
        if (k.toLowerCase() === "status") status = parseInt(v.join(":"), 10); else headers[k] = v.join(":").trim();
      }
      res.writeHead(status, headers);
      res.end(buf.slice(end + 4));
    });
  });
  return { ...host, repos, requests, git, token: GITHUB_TOKEN, clientId: CLIENT_ID, close: async () => { await host.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

module.exports = { startResend, startWordPress, cloudflareZones, startElementor, startSubfolder, startPlainSite, CHROME_MARKER, startUpdates, startGitHub, startGitHost, tarball, PNG };
