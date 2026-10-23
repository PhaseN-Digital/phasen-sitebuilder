// Turns a site.json into a deployable folder: public/ (static assets),
// worker/ (form Worker + forms.json) and wrangler.toml. The same output is
// used for the in-app preview, so preview and production can't drift.
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const { themes, fonts } = require("../themes/themes.json");
const RESERVED = new Set(["index", "404", "api", "assets", "styles", "form"]);

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const paragraphs = (text) =>
  String(text || "").split(/\n\s*\n/).filter((p) => p.trim()).map((p) => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
const img = (image, attrs = "") => (image?.src ? `<img src="/${esc(image.src)}" alt="${esc(image.alt)}" ${attrs}>` : "");

// Home is "/", every other page is its slugified title, deduped. Pages
// copied by an exact-copy import (lib/mirror.js) keep their original paths
// and own "/", so they're kept out of the slug space.
function pagePaths(pages) {
  const mirrored = pages.filter((p) => p.mirror);
  const used = new Set([...RESERVED, ...mirrored.map((p) => p.mirror.split("/")[1]).filter(Boolean)]);
  return new Map(
    pages.map((page, i) => {
      if (page.mirror) return [page.id, { file: null, href: page.mirror }];
      if (i === 0 && !mirrored.length) return [page.id, { file: "index.html", href: "/" }];
      let base = String(page.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      return [page.id, { file: `${slug}.html`, href: `/${slug}` }];
    })
  );
}

// Readable text colour (black/white) for a background hex colour.
function contrastText(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lum = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b) > 0.4 ? "#111111" : "#ffffff";
}

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
      // Sanitized by the editor (app/wordpress.js); only page links and image paths change here.
      const html = String(section.html || "")
        .replace(/href="#page:([a-z0-9]+)"/g, (_, id) => `href="${ctx.paths.get(id)?.href || "/"}"`)
        .replace(/src="assets\//g, 'src="/assets/');
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

function renderPage(site, ctx, page, main) {
  const brand = site.logo?.src ? `<img src="/${esc(site.logo.src)}" alt="${esc(site.name)}">` : esc(site.name);
  const nav = site.pages
    .map((p) => {
      const { href } = ctx.paths.get(p.id);
      return `<a href="${href}"${p === page ? ' aria-current="page"' : ""}>${esc(p.title)}</a>`;
    })
    .join("");
  const scripts = ctx.hasForm
    ? `<script src="/form.js"></script>\n<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad" async defer></script>`
    : "";
  const title = page && page !== site.pages[0] ? `${page.title} | ${site.name}` : site.name;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(site.description)}">
${site.logo?.src ? `<link rel="icon" href="/${esc(site.logo.src)}">` : ""}
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="site-header"><div class="wrap"><a class="brand" href="/">${brand}</a><nav>${nav}</nav></div></header>
<main>${main}</main>
<footer class="site-footer"><div class="wrap">&copy; ${new Date().getFullYear()} ${esc(site.name)}</div></footer>
${scripts}
</body>
</html>
`;
}

function renderCss(site) {
  const c = site.colors;
  const vars = `:root {
  --background: ${c.background}; --text: ${c.text}; --primary: ${c.primary}; --accent: ${c.accent};
  --primary-text: ${contrastText(c.primary)}; --accent-text: ${contrastText(c.accent)};
  --font: ${(fonts[site.font] || fonts.sans).stack};
}
`;
  return Promise.all([
    fs.readFile(path.join(ROOT, "themes", "base.css"), "utf8"),
    fs.readFile(path.join(ROOT, "themes", `${themes[site.theme] ? site.theme : "clean"}.css`), "utf8"),
  ]).then(([base, theme]) => vars + base + theme);
}

// publish: { workerName, hostname, sitekey, fromAddress, defaultTo }, or { preview: true }
// (the preview serves copied pages straight from the site folder instead).
async function build(site, siteDir, outDir, publish = {}) {
  const pub = path.join(outDir, "public");
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, "worker"), { recursive: true });
  await fs.cp(path.join(siteDir, "assets"), path.join(pub, "assets"), { recursive: true }).catch(() => fs.mkdir(pub, { recursive: true }));

  const paths = pagePaths(site.pages);
  const writes = site.pages.filter((page) => !page.mirror).map((page) => {
    const ctx = { site, paths, sitekey: publish.sitekey || "", hasForm: false };
    const main = page.sections.map((s) => renderSection(s, ctx)).join("\n");
    return fs.writeFile(path.join(pub, paths.get(page.id).file), renderPage(site, ctx, page, main));
  });
  const notFound = `<section class="notfound"><div class="wrap"><h1>Page not found</h1><p>Sorry, that page doesn't exist.</p><a class="button" href="/">Back to the home page</a></div></section>`;
  writes.push(fs.writeFile(path.join(pub, "404.html"), renderPage(site, { paths }, null, notFound)));
  writes.push(renderCss(site).then((css) => fs.writeFile(path.join(pub, "styles.css"), css)));
  writes.push(fs.copyFile(path.join(ROOT, "runtime", "form.js"), path.join(pub, "form.js")));
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
      await fs.writeFile(target, html
        .replace(/\sdata-sb-edit="[^"]*"/g, "")
        .replaceAll("__TURNSTILE_SITEKEY__", esc(publish.sitekey || ""))
        .replace(/data-form="([a-z0-9]+)" data-success="__FORM_SUCCESS__"/g, (_, id) =>
          `data-form="${id}" data-success="${esc(site.forms.find((f) => f.id === id)?.success || "Thanks, your message has been sent.")}"`));
    }
  }
  return Object.fromEntries([...paths].map(([id, p]) => [id, p.href]));
}

module.exports = { build, themes, fonts };
