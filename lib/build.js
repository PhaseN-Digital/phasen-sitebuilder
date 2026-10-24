// Turns a site.json into a deployable folder: public/ (static assets),
// worker/ (form Worker + forms.json) and wrangler.toml. The same output is
// used for the in-app preview, so preview and production can't drift.
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { themes, fonts, baseCss, loadTheme } = require("./themes");
const RESERVED = new Set(["index", "404", "api", "assets", "styles", "form"]);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const paragraphs = (text) =>
  String(text || "").split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
// The site's Google Analytics measurement ID, if it's set and well-formed.
const gaId = (site) => (/^G-[A-Z0-9]+$/i.test(site.analyticsId?.trim() || "") ? site.analyticsId.trim().toUpperCase() : "");
// Rich text's video placeholder (app/wordpress.js SAFE_VIDEO) as a click-to-load
// player: a srcdoc frame with a play link, so nothing loads from YouTube/Vimeo
// until the visitor clicks, then the link navigates the frame to the player.
const VIDEO = /<div class="video-embed" data-src="(https:\/\/(?:www\.youtube-nocookie\.com\/embed\/[\w-]{11}|player\.vimeo\.com\/video\/\d+))"><\/div>/g;
const videoEmbed = (_, url) => {
  const host = url.includes("vimeo") ? "Vimeo" : "YouTube";
  const doc = `<style>html,body{height:100%;margin:0}a{display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;height:100%;background:#111;color:#fff;font:600 1.1rem system-ui,sans-serif;text-decoration:none}span{font-size:3rem;line-height:1}small{font-weight:400;opacity:.8}</style><a href="${url}?autoplay=1"><span>&#9654;</span>Play video<small>Loads from ${host}</small></a>`;
  return `<div class="video-embed"><iframe title="Video from ${host}" srcdoc="${esc(doc)}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" loading="lazy"></iframe></div>`;
};
const img = (image, attrs = "") => (image?.src ? `<img src="/${esc(image.src)}" alt="${esc(image.alt)}" ${attrs}>` : "");

// Home is "/", every other page is its slugified title, deduped. Pages
// copied by an exact-copy import (lib/mirror.js) keep their original paths
// and own "/", so they're kept out of the slug space. Pages from an editable
// WordPress import keep their original `path` (e.g. "/services/web/") when
// it's a plain slug path that's free; otherwise (or as Home) they get a slug
// and `redirects` gets an old -> new 301. The generated privacy page's slug
// is always reserved, so pages don't move when a form is added.
function pagePaths(pages) {
  const mirrored = pages.filter((p) => p.mirror);
  const used = new Set([...RESERVED, ...mirrored.map((p) => p.mirror.split("/")[1]).filter(Boolean)]);
  const homeId = !mirrored.length && pages[0]?.id;
  const kept = new Map(), claimed = new Set();
  for (const page of pages) {
    const key = page.path?.replace(/^\/|\/$/g, "");
    if (!key || page.mirror || page.id === homeId) continue;
    const valid = /^[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*$/i.test(key) && !RESERVED.has(key.split("/")[0]);
    if (valid && !claimed.has(key)) { kept.set(page.id, key); claimed.add(key); }
  }
  for (const key of claimed) used.add(key.split("/")[0]);
  let privacy = used.has("privacy") ? "privacy-notice" : "privacy";
  for (let n = 2; used.has(privacy); n++) privacy = `privacy-notice-${n}`;
  used.add(privacy);
  const redirects = [];
  const paths = new Map([
    ["privacy", { file: `${privacy}.html`, href: `/${privacy}` }],
    ...pages.map((page) => {
      if (page.mirror) return [page.id, { file: null, href: page.mirror }];
      if (kept.has(page.id)) return [page.id, { file: `${kept.get(page.id)}/index.html`, href: `/${kept.get(page.id)}/` }];
      let entry;
      if (page.id === homeId) entry = { file: "index.html", href: "/" };
      else {
        let base = String(page.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
        let slug = base;
        for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
        used.add(slug);
        entry = { file: `${slug}.html`, href: `/${slug}` };
      }
      // An old address nobody else now owns redirects to the page's new one.
      const old = page.path?.replace(/^\/|\/$/g, "");
      if (old && !claimed.has(old)) redirects.push([page.path, entry.href]);
      return [page.id, entry];
    }),
  ]);
  return { paths, redirects };
}

// WCAG contrast ratio between two hex colours (1 to 21).
function contrastRatio(a, b) {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Readable text colour for a background: whichever of black or white contrasts more.
const contrastText = (hex) => (contrastRatio(hex, "#111111") >= contrastRatio(hex, "#ffffff") ? "#111111" : "#ffffff");

function renderSection(section, ctx) {
  switch (section.type) {
    case "hero": {
      const bg = section.image?.src ? ` style="background-image:url('/${esc(section.image.src)}')"` : "";
      const target = ctx.paths.get(section.buttonPage);
      const button = section.buttonText && target ? `<a class="button" href="${target.href}">${esc(section.buttonText)}</a>` : "";
      return `<section class="hero${bg ? " has-image" : ""}"${bg}><div class="wrap"><h1>${esc(section.heading)}</h1>${paragraphs(section.text)}${button}</div></section>`;
    }
    case "text": {
      const body = `<div>${section.heading ? `<h2>${esc(section.heading)}</h2>` : ""}${paragraphs(section.text)}</div>`;
      const picture = img(section.image, 'loading="lazy"');
      return `<section class="text${section.imageLeft ? " image-left" : ""}"><div class="wrap${picture ? " split" : ""}">${body}${picture}</div></section>`;
    }
    case "richtext": {
      // Sanitized by the editor (app/wordpress.js); only page links, image paths and videos change here.
      const html = String(section.html || "")
        .replace(/href="#page:([a-z0-9]+)"/g, (_, id) => `href="${ctx.paths.get(id)?.href || "/"}"`)
        .replace(/src="assets\//g, 'src="/assets/')
        .replace(VIDEO, videoEmbed);
      return `<section class="richtext"><div class="wrap">${html}</div></section>`;
    }
    case "gallery":
      return `<section class="gallery"><div class="wrap">${section.heading ? `<h2>${esc(section.heading)}</h2>` : ""}<div class="gallery-grid">${(section.images || []).map((i) => img(i, 'loading="lazy"')).join("")}</div></div></section>`;
    case "form": {
      const form = ctx.site.forms.find((f) => f.id === section.formId);
      if (!form) return "";
      ctx.hasForm = true;
      const fields = form.fields
        .map((f) => {
          const attrs = `name="${esc(f.id)}"${f.required ? " required" : ""}`;
          const input = f.type === "textarea" ? `<textarea ${attrs}></textarea>` : `<input type="${esc(f.type)}" ${attrs}>`;
          return `<label>${esc(f.label)}${f.required ? "" : " (optional)"}${input}</label>`;
        })
        .join("");
      return `<section class="form"><div class="wrap">${section.heading ? `<h2>${esc(section.heading)}</h2>` : ""}${paragraphs(section.text)}
<form data-form="${esc(form.id)}" data-success="${esc(form.success)}">${fields}
<label class="hp" aria-hidden="true">Leave blank<input name="website" tabindex="-1" autocomplete="off"></label>
<div class="cf-turnstile" data-sitekey="${esc(ctx.sitekey)}"></div>
<button class="button" type="submit">${esc(section.buttonText || "Send")}</button>
<p class="form-status" role="status" aria-live="polite"></p></form></div></section>`;
    }
    default:
      return "";
  }
}

// Days the form inbox keeps messages (#75): the Worker deletes older ones.
const inboxDays = (site) => Math.max(1, Math.round(Number(site.inboxDays)) || 90);

// Privacy notice for sites with forms or analytics (UK GDPR, PECR). Plain
// wording; the editor tells the user it's a starting point, not legal advice.
function renderPrivacy(site, forms, email, analytics) {
  const owner = esc(site.privacy?.owner?.trim() || site.name);
  const contact = email ? `at <a href="mailto:${esc(email)}">${esc(email)}</a>` : forms.length ? "through the form on this website" : "using the contact details on this website";
  const retention = site.privacy?.retention?.trim() || (!forms.length ? "Google Analytics keeps visit data for the period set in our account, after which it's deleted automatically." : `We keep messages in our website's inbox for up to ${inboxDays(site)} days, after which they're deleted automatically. Copies sent to us by email are kept only for as long as we need them to deal with your enquiry and any follow-up.`);
  const collected = forms.length && forms.map((f) => `<li><strong>${esc(f.name)}</strong>: ${f.fields.map((x) => esc(x.label)).join(", ")}</li>`).join("");
  return `<section class="richtext"><div class="wrap">
<h1>Privacy ${analytics ? "and cookie " : ""}notice</h1>
<p>This page explains what happens to ${forms.length ? "the information you send us through this website" : "information about your visits to this website"}.</p>
<h2>Who we are</h2>
<p>This website is run by ${owner}, who is responsible for (the "data controller" of) the personal information described here. You can contact us ${contact}.</p>
<h2>What we collect and why</h2>
${collected ? `<p>When you fill in a form on this website, we receive what you type into it:</p>
<ul>${collected}</ul>
<p>We use it only to reply to you and deal with your request. Our legal basis is "legitimate interests": you've asked us to get in touch. We don't sell your information or use it for advertising.</p>` : ""}
${analytics ? `<h3>Analytics and cookies</h3>
<p>If you agree, we use Google Analytics to understand how visitors find and use this website, such as which pages are viewed and roughly where visitors are. It sets cookies in your browser to tell visits apart. These cookies are only set after you click <strong>Accept</strong> on the cookie banner; if you click <strong>Reject</strong>, no analytics cookies are set. Our legal basis is your consent.</p>
<p>We remember your choice in your browser's storage (not a cookie) so we don't ask on every page. You can change your mind at any time with the <strong>Cookie preferences</strong> link at the bottom of every page.</p>` : ""}
<h2>Who else handles it</h2>
<ul><li><strong>Cloudflare</strong> hosts this website${collected ? ", stores the messages you send through our forms, and runs Turnstile, a spam check on our forms. Turnstile looks at technical details from your browser and device, such as your IP address, to tell people apart from bots" : ""}.</li>
${collected ? "<li><strong>Resend</strong> delivers your form messages to us by email.</li>" : ""}
${analytics ? "<li><strong>Google</strong> provides Google Analytics, only if you accept analytics cookies.</li>" : ""}</ul>
<p>They handle it on our behalf under their own privacy policies, and may do so outside the UK with the safeguards the law requires.</p>
<h2>How long we keep it</h2>
${paragraphs(retention)}
<h2>Your rights</h2>
<p>Under UK data protection law (UK GDPR) you can ask us for a copy of the information we hold about you, ask us to correct or delete it, or object to how we use it. Contact us ${contact}.</p>
<p>If you're unhappy with how we've handled your information, you can complain to the Information Commissioner's Office at <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk</a>.</p>
</div></section>`;
}

// Mobile menu (base.css hides the nav behind the toggle on narrow screens).
// Only collapses once this runs, so without JS the nav stays visible.
const NAV_SCRIPT = `(function(){var h=document.querySelector(".site-header"),b=h.querySelector(".nav-toggle");function set(o){b.setAttribute("aria-expanded",o);h.classList.toggle("nav-open",o)}b.hidden=false;h.classList.add("has-nav-toggle");b.onclick=function(){set(b.getAttribute("aria-expanded")!=="true")};document.getElementById("site-nav").addEventListener("click",function(e){if(e.target.closest("a"))set(false)});document.addEventListener("keydown",function(e){if(e.key==="Escape"&&b.getAttribute("aria-expanded")==="true"){set(false);b.focus()}})})();`;

function renderPage(site, ctx, page, main) {
  const brand = site.logo?.src ? `<img src="/${esc(site.logo.src)}" alt="${esc(site.name)}">` : esc(site.name);
  // The privacy page skips copied pages: an exact copy can have hundreds.
  const nav = (page?.noindex ? site.pages.filter((p) => !p.mirror) : site.pages)
    .map((p) => {
      const { href } = ctx.paths.get(p.id);
      return `<a href="${href}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`;
    })
    .join("");
  const scripts = ctx.hasForm
    ? `<script src="/form.js"></script>\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad" async defer></script>`
    : "";
  const privacy = ctx.paths.get("privacy");
  const ga = gaId(site);
  const consent = ga
    ? `<div id="cookie-banner" class="cookie-banner" hidden role="dialog" aria-label="Cookie consent"><div class="wrap">
<p>This site uses Google Analytics to understand how visitors find and use it. Analytics cookies are only set if you accept.${privacy ? ` See the <a href="${privacy.href}">privacy and cookie notice</a>.` : ""}</p>
<div class="cookie-banner-actions"><button type="button" id="cookie-reject" class="button">Reject</button><button type="button" id="cookie-accept" class="button">Accept</button></div></div></div>
<script src="/consent.js" data-ga-id="${ga}"></script>`
    : "";
  const title = page?.seoTitle?.trim() || (page && page !== site.pages[0] ? `${page.title} | ${site.name}` : site.name);
  const description = page?.seoDescription?.trim() || site.description || "";
  // Absolute URLs need the published hostname, so the preview (and an export
  // without a domain) leaves out canonical and og:url.
  const origin = ctx.origin || "";
  const url = origin && page?.id && !page.noindex && origin + ctx.paths.get(page.id).href;
  const image = page?.shareImage || site.logo?.src;
  const seo = [
    url && `<link rel="canonical" href="${esc(url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    url && `<meta property="og:url" content="${esc(url)}">`,
    image && `<meta property="og:image" content="${esc(`${origin}/${image}`)}">`,
    `<meta name="twitter:card" content="summary">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    image && `<meta name="twitter:image" content="${esc(`${origin}/${image}`)}">`,
  ].filter(Boolean).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${page?.noindex ? '<meta name="robots" content="noindex">' : ""}
${seo}
${site.logo?.src ? `<link rel="icon" href="/${esc(site.logo.src)}">` : ""}
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header"><div class="wrap"><a class="brand" href="/">${brand}</a><button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav" hidden>Menu</button><nav id="site-nav" aria-label="Main">${nav}</nav></div></header>
<script>${NAV_SCRIPT}</script>
<main>${main}</main>
<footer class="site-footer"><div class="wrap">&copy; ${new Date().getFullYear()} ${esc(site.name)}${privacy ? ` · <a href="${privacy.href}">Privacy</a>` : ""}${ga ? ` · <a href="#" onclick="reopenCookieBanner(); return false;">Cookie preferences</a>` : ""}</div></footer>
${consent}
${scripts}
</body>
</html>
`;
}

function renderCss(site, siteDir) {
  // A theme from a theme source is copied into the site folder (lib/theme-sources.js).
  // Loaded before reading `fonts`: that registers its font stack, if it has one.
  const themeDir = site.themeSource ? loadTheme(path.join(siteDir, "theme"), site.theme).dir : (themes[site.theme] || themes.clean).dir;
  const c = site.colors;
  const vars = `:root {
  --background: ${c.background}; --text: ${c.text}; --primary: ${c.primary}; --accent: ${c.accent};
  --primary-text: ${contrastText(c.primary)}; --accent-text: ${contrastText(c.accent)};
  --font: ${(fonts[site.font] || fonts.sans).stack};
}
`;
  return Promise.all([
    fs.readFile(baseCss, "utf8"),
    fs.readFile(path.join(themeDir, "theme.css"), "utf8"),
  ]).then(([base, theme]) => vars + base + theme);
}

// Uploaded images (sites/<id>/assets) that site.json or a copied page still
// uses. mirror-original counts too: "Revert this page" restores from it.
async function usedAssets(site, siteDir) {
  let text = JSON.stringify(site);
  for (const dir of ["mirror", "mirror-original"]) {
    const files = await fs.readdir(path.join(siteDir, dir), { recursive: true }).catch(() => []);
    for (const f of files) if (f.endsWith(".html")) text += await fs.readFile(path.join(siteDir, dir, f), "utf8");
  }
  const names = await fs.readdir(path.join(siteDir, "assets")).catch(() => []);
  return new Set(names.filter((n) => text.includes(`assets/${n}`)));
}

// Deletes unused uploads. Only safe when no copied-page undo history (kept in
// the editor's memory) can point at one, so main.js runs it at startup; the
// grace period covers an upload whose site.json save never landed.
async function pruneAssets(site, siteDir, graceMs = 864e5) {
  if (!site) return; // unreadable site.json: everything would look unused
  const used = await usedAssets(site, siteDir);
  const dir = path.join(siteDir, "assets");
  for (const n of await fs.readdir(dir).catch(() => [])) {
    const file = path.join(dir, n);
    if (!used.has(n) && (await fs.stat(file)).mtimeMs < Date.now() - graceMs) await fs.rm(file);
  }
}

// publish: { workerName, hostname, sitekey, fromAddress, defaultTo, d1: { id, name } (the form inbox, #75) }, or { preview: true }
// (hostname also makes the canonical/og:url links, sitemap.xml and robots.txt)
// (the preview serves copied pages straight from the site folder instead).
async function build(site, siteDir, outDir, publish = {}) {
  const pub = path.join(outDir, "public");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, "worker"), { recursive: true });
  // Published output gets only the images still in use; the preview serves
  // /assets straight from the site folder (main.js), so it copies them all.
  const used = !publish.preview && (await usedAssets(site, siteDir));
  const assets = path.join(siteDir, "assets");
  await fs.cp(assets, path.join(pub, "assets"), { recursive: true, filter: (f) => !used || f === assets || used.has(path.basename(f)) })
    .catch(() => fs.mkdir(pub, { recursive: true }));

  const { paths, redirects } = pagePaths(site.pages);
  const origin = !publish.preview && publish.hostname ? `https://${publish.hostname}` : "";
  const usedForms = site.forms.filter((f) => f.mirrored || site.pages.some((p) => p.sections.some((s) => s.type === "form" && s.formId === f.id)));
  const analytics = Boolean(gaId(site));
  if (!usedForms.length && !analytics) paths.delete("privacy");
  const writes = site.pages.filter((page) => !page.mirror).map((page) => {
    const ctx = { site, paths, origin, sitekey: publish.sitekey || "", hasForm: false };
    const main = page.sections.map((s) => renderSection(s, ctx)).join("\n");
    const file = path.join(pub, paths.get(page.id).file);
    return fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, renderPage(site, ctx, page, main)));
  });
  // Editable-import pages whose old WordPress address changed (an exact copy brings its own _redirects).
  if (redirects.length) writes.push(fs.writeFile(path.join(pub, "_redirects"), redirects.map(([from, to]) => `${encodeURI(from)} ${to} 301\n`).join("")));
  const notFound = `<section class="notfound"><div class="wrap"><h1>Page not found</h1><p>Sorry, that page doesn't exist.</p><a class="button" href="/">Back to the home page</a></div></section>`;
  writes.push(fs.writeFile(path.join(pub, "404.html"), renderPage(site, { paths, origin }, null, notFound)));
  if (usedForms.length || analytics) {
    const email = usedForms.find((f) => f.to)?.to || publish.defaultTo;
    writes.push(fs.writeFile(path.join(pub, paths.get("privacy").file), renderPage(site, { paths, origin }, { title: "Privacy", noindex: true }, renderPrivacy(site, usedForms, email, analytics))));
  }
  writes.push(renderCss(site, siteDir).then((css) => fs.writeFile(path.join(pub, "styles.css"), css)));
  writes.push(fs.copyFile(path.join(ROOT, "runtime", "form.js"), path.join(pub, "form.js")));
  if (analytics) writes.push(fs.copyFile(path.join(ROOT, "runtime", "consent.js"), path.join(pub, "consent.js")));
  writes.push(fs.copyFile(path.join(ROOT, "runtime", "worker.js"), path.join(outDir, "worker", "index.js")));

  const forms = Object.fromEntries(
    site.forms.map((f) => [f.id, { name: f.name, to: f.to || publish.defaultTo || "", fields: f.fields.map(({ id, label, type, required }) => ({ id, label, type, required })) }])
  );
  writes.push(fs.writeFile(path.join(outDir, "worker", "forms.json"), JSON.stringify(forms, null, 2)));

  const toml = `name = ${JSON.stringify(publish.workerName || "my-site")}
main = "worker/index.js"
compatibility_date = "2025-01-01"
workers_dev = ${!publish.hostname?.length || publish.hostname.endsWith(".workers.dev")}

[vars]
SITE_NAME = ${JSON.stringify(site.name)}
FROM_ADDRESS = ${JSON.stringify(publish.fromAddress || "onboarding@resend.dev")}
RETENTION_DAYS = ${inboxDays(site)}
${publish.d1 ? `\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = ${JSON.stringify(publish.d1.name)}\ndatabase_id = ${JSON.stringify(publish.d1.id)}\n` : ""}
[assets]
directory = "./public"
binding = "ASSETS"
not_found_handling = "404-page"
${publish.hostname && !publish.hostname.endsWith(".workers.dev") ? `\n[[routes]]\npattern = ${JSON.stringify(publish.hostname)}\ncustom_domain = true\n` : ""}`;
  writes.push(fs.writeFile(path.join(outDir, "wrangler.toml"), toml));
  writes.push(
    fs.writeFile(
      path.join(outDir, "README.md"),
      `# ${site.name}\n\nBuilt by PhaseN Site Builder. To deploy by hand:\n\n    npx wrangler deploy\n    npx wrangler secret put TURNSTILE_SECRET_KEY\n    npx wrangler secret put RESEND_API_KEY\n\nLocal test: \`npx wrangler dev\` (with a .dev.vars containing TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA).\n`
    )
  );
  await Promise.all(writes);

  if (site.mirror && !publish.preview) {
    await fs.cp(path.join(siteDir, "mirror"), pub, { recursive: true });
    // Copied pages carry editor tags (app/copied.js) and, where they had
    // WordPress forms, placeholders filled in here.
    const files = new Set([...site.pages.filter((p) => p.mirror && p.file).map((p) => p.file), "404.html", ...(site.mirror.formFiles || [])]);
    for (const file of files) {
      const target = path.join(pub, file);
      const html = await fs.readFile(target, "utf8").catch(() => null);
      if (html == null) continue;
      await fs.writeFile(target, absolutise(html, origin)
        .replace(/\sdata-sb-edit="[^"]*"/g, "")
        .replaceAll("__TURNSTILE_SITEKEY__", esc(publish.sitekey || ""))
        .replace(/data-form="([a-z0-9]+)" data-success="__FORM_SUCCESS__"/g, (_, id) =>
          `data-form="${id}" data-success="${esc(site.forms.find((f) => f.id === id)?.success || "Thanks, your message has been sent.")}"`));
    }
    for (const file of ["robots.txt", "sitemap.xml"]) {
      const text = await fs.readFile(path.join(pub, file), "utf8").catch(() => null);
      if (text != null) await fs.writeFile(path.join(pub, file), absolutise(text, origin));
    }
  }
  if (origin) await writeSitemap(site, paths, pub, origin);
  return Object.fromEntries([...paths].map(([id, p]) => [id, p.href]));
}

// lib/mirror.js leaves an exact copy's canonical, og:url/og:image and
// twitter:url/image tags, and the original robots.txt/sitemap.xml, root-relative;
// these must be absolute URLs, on the published hostname (#115). No hostname, no change.
function absolutise(text, origin) {
  if (!origin) return text;
  return text
    .replace(/<(?:link|meta)\b[^>]*>/gi, (tag) => (/\b(?:rel=["']?canonical|(?:property|name)=["']?(?:og:url|og:image(?::secure_url)?|twitter:url|twitter:image(?::src)?))\b/i.test(tag)
      ? tag.replace(/\b(href|content)=(["'])\/(?!\/)/i, `$1=$2${origin}/`) : tag))
    .replace(/(<(?:image:)?loc>\s*|^Sitemap:\s*)\/(?!\/)/gim, `$1${origin}/`);
}

// sitemap.xml (indexable pages only) and robots.txt pointing at it, like
// phasen.digital's. An exact copy keeps its own if it brought them.
async function writeSitemap(site, paths, pub, origin) {
  const exists = (f) => fs.access(path.join(pub, f)).then(() => true, () => false);
  if (!(await exists("sitemap.xml"))) {
    const urls = [];
    for (const page of site.pages) {
      if (page.mirror) {
        const html = page.file && (await fs.readFile(path.join(pub, page.file), "utf8").catch(() => null));
        if (html == null || /<meta\b[^>]*\bnoindex\b[^>]*>/i.test(html)) continue;
      }
      urls.push(`  <url><loc>${esc(origin + encodeURI(paths.get(page.id).href))}</loc></url>\n`);
    }
    await fs.writeFile(path.join(pub, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`);
  }
  if (!(await exists("robots.txt"))) await fs.writeFile(path.join(pub, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`);
}

module.exports = { build, pruneAssets, themes, fonts, inboxDays, contrastRatio, contrastText };
