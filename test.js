// Self-check for the site builder: `npm test`. Builds a sample site and
// asserts on the output.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build, pruneAssets, stampHtml } = require("./lib/build");

const site = {
  id: "test", name: "Bob's <Bikes>", description: "Bikes & repairs", theme: "bold", font: "serif",
  colors: { background: "#ffffff", text: "#111111", primary: "#ffee00", accent: "#000000" },
  logo: null, domain: null, workerName: "bobs-bikes-test",
  pages: [
    { id: "h", title: "Home", sections: [{ type: "hero", heading: "<script>x</script>", text: "Hi\n\nThere", buttonText: "Go", buttonPage: "c" }] },
    { id: "c", title: "Contact Us!", sections: [{ type: "form", formId: "contact", heading: "Ask", buttonText: "Send" }] },
    { id: "d", title: "404", sections: [{ type: "richtext", html: '<p><a href="#page:c">Contact</a> <img src="assets/abc123.webp" alt=""></p>'
      + '<p class="align-center"><a href="#page:c" class="button">Book</a></p><figure class="align-right"><img src="assets/abc123.webp" alt="Bike"><figcaption>Ours</figcaption></figure>'
      + '<div class="video-embed" data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"></div><div class="video-embed" data-src="https://player.vimeo.com/video/76979871"></div>'
      + '<div class="video-embed" data-src="https://evil.example/embed/x"></div>' }] },
  ],
  forms: [{ id: "contact", name: "Contact", to: "", success: "Thanks", fields: [
    { id: "name", label: "Name", type: "text", required: true },
    { id: "email", label: "Email", type: "email", required: true },
    { id: "message", label: "Message", type: "textarea", required: false },
  ] }],
};

(async () => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  // Uploads: one used by site.json, one only by a copied page's original (revert needs it), one unused.
  for (const d of ["assets", "mirror-original/about"]) fs.mkdirSync(path.join(siteDir, d), { recursive: true });
  for (const n of ["abc123", "orig", "old"]) fs.writeFileSync(path.join(siteDir, `assets/${n}.webp`), "x");
  fs.writeFileSync(path.join(siteDir, "mirror-original/about/index.html"), '<img src="/assets/orig.webp">');
  const out = path.join(os.tmpdir(), "sitebuilder-test-out");
  const paths = await build(site, siteDir, out, { workerName: site.workerName, sitekey: "SITEKEY", defaultTo: "owner@example.com" });
  const read = (f) => fs.readFileSync(path.join(out, f), "utf8");

  assert.deepStrictEqual(paths, { privacy: "/privacy", h: "/", c: "/contact-us", d: "/404-2" }); // reserved "404" slug deduped
  const home = read("public/index.html");
  assert(home.includes("&lt;script&gt;x&lt;/script&gt;") && !home.includes("<script>x"), "user text is escaped");
  assert(home.includes('href="/contact-us"') && home.includes("<p>Hi</p><p>There</p>"));
  assert(/<button type="button" class="nav-toggle" aria-expanded="false" aria-controls="site-nav" hidden>/.test(home) && home.includes('<nav id="site-nav"'), "mobile menu toggle, hidden until its script runs");
  assert(!home.includes("turnstile"), "no captcha script on pages without forms");
  const contact = read("public/contact-us.html");
  assert(contact.includes('data-sitekey="SITEKEY"') && contact.includes('name="website"') && contact.includes("turnstile/v0/api.js"));
  assert(read("public/styles.css").includes("--primary-text: #111111"), "dark text on a yellow button");
  assert.strictEqual(JSON.parse(read("worker/forms.json")).contact.to, "owner@example.com");
  assert(read("wrangler.toml").includes("workers_dev = true") && !read("wrangler.toml").includes("custom_domain"));
  assert(read("public/404-2.html").includes('<a href="/contact-us">Contact</a> <img src="/assets/abc123.webp"'), "richtext page links + image paths resolved");
  const rich = read("public/404-2.html");
  assert(rich.includes('<p class="align-center"><a href="/contact-us" class="button">Book</a></p><figure class="align-right"><img src="/assets/abc123.webp" alt="Bike">'), "rich text: button links, alignment, figures");
  const players = [...rich.matchAll(/<div class="video-embed"><iframe title="Video from (\w+)" srcdoc="([^"]*)"/g)];
  assert.deepStrictEqual(players.map((m) => m[1]), ["YouTube", "Vimeo"], "videos become click-to-load players");
  assert(players[0][2].includes("&lt;a href=&quot;https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&quot;&gt;") && players[1][2].includes("https://player.vimeo.com/video/76979871?autoplay=1"));
  assert(!/<iframe[^>]* src=|evil\.example\/embed\/x"><\/iframe/.test(rich), "nothing loads from a video host before a click, unapproved hosts never become players");
  // Sites with a form get a noindex privacy page, linked from every footer.
  const privacy = read("public/privacy.html");
  assert(privacy.includes('<meta name="robots" content="noindex">') && privacy.includes("Bob&#39;s &lt;Bikes&gt;, who is responsible"));
  assert(privacy.includes("<li><strong>Contact</strong>: Name, Email, Message</li>") && privacy.includes('href="mailto:owner@example.com"') && privacy.includes("Resend"));
  assert(home.includes('<a href="/privacy">Privacy</a>') && !read("public/index.html").includes('name="robots"'));
  for (const f of ["public/404.html", "public/form.js", "worker/index.js"]) assert(fs.existsSync(path.join(out, f)), f);

  assert.deepStrictEqual(fs.readdirSync(path.join(out, "public/assets")).sort(), ["abc123.webp", "orig.webp"], "unused uploads aren't published");
  await pruneAssets(site, siteDir);
  assert.strictEqual(fs.readdirSync(path.join(siteDir, "assets")).length, 3, "fresh uploads survive the grace period");
  await pruneAssets(null, siteDir, 0);
  assert.strictEqual(fs.readdirSync(path.join(siteDir, "assets")).length, 3, "unreadable site.json deletes nothing");
  await pruneAssets(site, siteDir, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(siteDir, "assets")).sort(), ["abc123.webp", "orig.webp"], "unused upload deleted");

  await build({ ...site, pages: site.pages.slice(0, 1), privacy: { owner: "Bob Ltd", retention: "A year." } }, siteDir, out, {});
  assert(!fs.existsSync(path.join(out, "public/privacy.html")) && !read("public/index.html").includes("/privacy"), "no privacy page without a form");
  await build({ ...site, privacy: { owner: "Bob Ltd", retention: "A year." } }, siteDir, out, {});
  assert(read("public/privacy.html").includes("run by Bob Ltd") && read("public/privacy.html").includes("<p>A year.</p>") && read("public/privacy.html").includes("contact us through the form"));

  // Analytics: consent banner + consent.js only with a valid ID, never gtag before consent; analytics alone still gets a privacy page.
  assert(!home.includes("cookie-banner") && !fs.existsSync(path.join(out, "public/consent.js")), "no banner without an ID");
  await build({ ...site, pages: site.pages.slice(0, 1), analyticsId: " g-abc123 " }, siteDir, out, {});
  const gaHome = read("public/index.html"), gaPrivacy = read("public/privacy.html");
  assert(gaHome.includes('id="cookie-banner" class="cookie-banner" hidden') && gaHome.includes('<script src="/consent.js" data-ga-id="G-ABC123">') && gaHome.includes("reopenCookieBanner()"));
  for (const f of ["public/index.html", "public/404.html", "public/privacy.html"]) assert(!/googletagmanager|gtag\(/.test(read(f)), `no gtag before consent in ${f}`);
  assert(read("public/consent.js").includes("googletagmanager") && gaHome.includes('<a href="/privacy">Privacy</a>'));
  assert(gaPrivacy.includes("Google Analytics") && gaPrivacy.includes("Cookie preferences") && !gaPrivacy.includes("Resend") && !gaPrivacy.includes("Turnstile"));
  await build({ ...site, analyticsId: "UA-1234" }, siteDir, out, {});
  assert(!read("public/index.html").includes("cookie-banner") && !read("public/privacy.html").includes("Google Analytics"), "malformed ID ignored");

  // Form inbox (#75): retention in the privacy page and Worker vars, D1 binding only once there's a database.
  await build({ ...site, inboxDays: "30" }, siteDir, out, { workerName: "w", d1: { id: "db-1", name: "w-inbox" } });
  assert(read("public/privacy.html").includes("inbox for up to 30 days") && read("public/privacy.html").includes("stores the messages you send"));
  assert(read("wrangler.toml").includes('RETENTION_DAYS = 30\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "w-inbox"\ndatabase_id = "db-1"\n'));
  await build(site, siteDir, out, {});
  assert(read("wrangler.toml").includes("RETENTION_DAYS = 90") && !read("wrangler.toml").includes("d1_databases") && read("public/privacy.html").includes("up to 90 days"));

  await build({ ...site, domain: { id: "z", name: "bobsbikes.co.uk" } }, siteDir, out, { workerName: "w", hostname: "bobsbikes.co.uk" });
  assert(read("wrangler.toml").includes('pattern = "bobsbikes.co.uk"\ncustom_domain = true') && read("wrangler.toml").includes("workers_dev = false"));
  await build({ ...site, domain: { zoneId: "z", zoneName: "bobsbikes.co.uk", label: "shop" } }, siteDir, out, { workerName: "w", hostname: "shop.bobsbikes.co.uk" });
  assert(read("wrangler.toml").includes('pattern = "shop.bobsbikes.co.uk"\ncustom_domain = true') && read("wrangler.toml").includes("workers_dev = false"), "subdomain route (#135)");

  // SEO (#74): per-page title/description/share image, canonical + sitemap only with a published hostname.
  const seoSite = { ...site, logo: { src: "assets/logo.webp", alt: "" }, pages: [{ ...site.pages[0], seoTitle: 'Bob\'s "best" <bikes>', seoDescription: "Fix & ride" }, { ...site.pages[2], shareImage: "assets/abc123.webp" }, site.pages[1]] };
  await build(seoSite, siteDir, out, { workerName: "w", hostname: "bobsbikes.co.uk" });
  const seoHome = read("public/index.html"), seoPage = read("public/404-2.html");
  assert(seoHome.includes("<title>Bob&#39;s &quot;best&quot; &lt;bikes&gt;</title>") && seoHome.includes('<meta name="description" content="Fix &amp; ride">'), "SEO title/description escaped");
  assert(seoHome.includes('<link rel="canonical" href="https://bobsbikes.co.uk/">') && seoHome.includes('<meta property="og:url" content="https://bobsbikes.co.uk/">'));
  assert(seoHome.includes('<meta property="og:image" content="https://bobsbikes.co.uk/assets/logo.webp">'), "logo is the default share image");
  assert(seoPage.includes('<meta property="og:image" content="https://bobsbikes.co.uk/assets/abc123.webp">') && seoPage.includes("<title>404 | Bob&#39;s &lt;Bikes&gt;</title>") && seoPage.includes('content="Bikes &amp; repairs"'), "per-page image, fallbacks");
  assert(!read("public/privacy.html").includes("canonical") && !read("public/404.html").includes("canonical"), "no canonical on noindex/404 pages");
  assert.strictEqual(read("public/sitemap.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://bobsbikes.co.uk/</loc></url>\n  <url><loc>https://bobsbikes.co.uk/404-2</loc></url>\n  <url><loc>https://bobsbikes.co.uk/contact-us</loc></url>\n</urlset>\n');
  assert.strictEqual(read("public/robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: https://bobsbikes.co.uk/sitemap.xml\n");
  await build(seoSite, siteDir, out, { preview: true, hostname: "bobsbikes.co.uk" });
  assert(!read("public/index.html").includes("canonical") && !read("public/index.html").includes("og:url") && read("public/index.html").includes('content="/assets/logo.webp"') && !fs.existsSync(path.join(out, "public/sitemap.xml")), "preview: no canonical/sitemap");
  // Exact copies: sitemap from the copied pages (skipping noindex ones) unless they brought their own.
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  fs.mkdirSync(path.join(copyDir, "mirror/caf\u00e9"), { recursive: true });
  fs.writeFileSync(path.join(copyDir, "mirror/index.html"), "<p>home</p>");
  fs.writeFileSync(path.join(copyDir, "mirror/caf\u00e9/index.html"), "<p>caf</p>");
  fs.writeFileSync(path.join(copyDir, "mirror/thanks.html"), '<meta name="robots" content="noindex, follow">');
  const copySite = { ...site, mirror: {}, forms: [], pages: [{ id: "m1", title: "Home", mirror: "/", file: "index.html", sections: [] }, { id: "m2", title: "Caf", mirror: "/caf\u00e9/", file: "caf\u00e9/index.html", sections: [] }, { id: "m3", title: "Thanks", mirror: "/thanks.html", file: "thanks.html", sections: [] }] };
  await build(copySite, copyDir, out, { hostname: "copy.example" });
  assert(read("public/sitemap.xml").includes("<loc>https://copy.example/</loc>") && read("public/sitemap.xml").includes("<loc>https://copy.example/caf%C3%A9/</loc>") && !read("public/sitemap.xml").includes("thanks"));
  fs.writeFileSync(path.join(copyDir, "mirror/robots.txt"), "User-agent: *\nDisallow:\n");
  fs.writeFileSync(path.join(copyDir, "mirror/sitemap.xml"), "<urlset>own</urlset>");
  await build(copySite, copyDir, out, { hostname: "copy.example" });
  assert(read("public/sitemap.xml") === "<urlset>own</urlset>" && read("public/robots.txt") === "User-agent: *\nDisallow:\n", "an exact copy keeps its own sitemap/robots");
  // A copied site's own /assets/ (#163): published next to the app's uploads, never pruned as one.
  for (const d of ["assets", "mirror/assets"]) fs.mkdirSync(path.join(copyDir, d), { recursive: true });
  fs.writeFileSync(path.join(copyDir, "mirror/assets/logo.png"), "LOGO");
  fs.writeFileSync(path.join(copyDir, "assets/0123456789ab.webp"), "UPLOAD");
  fs.writeFileSync(path.join(copyDir, "mirror/index.html"), '<img src="/assets/logo.png"><img src="/assets/0123456789ab.webp">');
  await build(copySite, copyDir, out, { hostname: "copy.example" });
  assert(read("public/assets/logo.png") === "LOGO" && read("public/assets/0123456789ab.webp") === "UPLOAD", "copied /assets/ files and uploads both published");
  fs.writeFileSync(path.join(copyDir, "mirror/index.html"), "<p>home</p>");
  await pruneAssets(copySite, copyDir, 0);
  assert(fs.existsSync(path.join(copyDir, "mirror/assets/logo.png")) && !fs.existsSync(path.join(copyDir, "assets/0123456789ab.webp")), "prune removes the unused upload only, never a copied file");

  // Import provenance marker (#141): every built page, theme-built and copied, plus the
  // well-known file; the declaring user's name and email never reach the output.
  {
    const importProvenance = { source: "https://old.example", importedAt: "2026-10-01T09:00:00.000Z", declaredAt: "2026-10-01T09:00:00.000Z", appVersion: "9.9.9",
      declaredBy: { name: "Jo Declarer", email: "jo.declarer@example.org" }, statement: "I confirm…", verification: { status: "verified", method: "verification-file", checkedAt: "2026-10-01T09:00:01.000Z" } };
    fs.writeFileSync(path.join(copyDir, "mirror/index.html"), '<!doctype html><html><head><meta name="generator" content="WordPress 6.5"><title>Home</title></head><body><p>home</p></body></html>');
    const stamped = { ...copySite, importProvenance, forms: [], pages: [...copySite.pages, { id: "t1", title: "Built", sections: [{ type: "text", heading: "Hi", text: "x" }] }] };
    const provOut = fs.mkdtempSync(path.join(os.tmpdir(), "sb-prov-"));
    await build(stamped, copyDir, provOut, { hostname: "copy.example" });
    const files = fs.readdirSync(path.join(provOut, "public"), { recursive: true }).map(String);
    const pages = files.filter((f) => f.endsWith(".html"));
    assert(pages.includes("index.html") && pages.includes("built.html") && pages.includes("404.html") && pages.length >= 5, pages.join());
    for (const f of pages) {
      const html = fs.readFileSync(path.join(provOut, "public", f), "utf8");
      assert(html.includes('<meta name="generator" content="PhaseN Site Builder">') && html.includes('<meta name="phasen:imported-from" content="https://old.example">')
        && html.includes('<meta name="phasen:imported-on" content="2026-10-01">'), `marker on ${f}`);
      assert.strictEqual((html.match(/name="generator"/g) || []).length, 1, `one generator tag on ${f}`);
    }
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(provOut, "public/.well-known/phasen-provenance.json"), "utf8")),
      { generator: "PhaseN Site Builder", source: "https://old.example", importedOn: "2026-10-01", appVersion: "9.9.9", verification: "verified", verificationMethod: "verification-file" });
    for (const f of fs.readdirSync(provOut, { recursive: true }).map(String)) {
      const file = path.join(provOut, f);
      if (fs.statSync(file).isFile()) assert(!/Jo Declarer|jo\.declarer/i.test(fs.readFileSync(file, "utf8")), `no personal data in ${f}`);
    }
    // The preview stamps copied pages as main.js serves them (#145): same tags, nothing personal.
    const previewed = stampHtml('<html><head><meta name="generator" content="WordPress 6.5"><title>x</title></head><body></body></html>', importProvenance);
    assert(previewed.includes('<meta name="phasen:imported-from" content="https://old.example">') && previewed.includes('content="2026-10-01"')
      && (previewed.match(/name="generator"/g) || []).length === 1 && !/Jo Declarer|jo\.declarer/.test(previewed), previewed);
    assert.strictEqual(stampHtml("<p>x</p>", undefined), "<p>x</p>");
    await build(copySite, copyDir, provOut, { hostname: "copy.example" });
    assert(!fs.existsSync(path.join(provOut, "public/.well-known")) && !fs.readFileSync(path.join(provOut, "public/index.html"), "utf8").includes("phasen:"), "no marker without provenance");
  }

  // Editable WordPress import keeps each page's old address where it can, and 301s the rest (#72).
  const wpPage = (id, title, p, sections = []) => ({ id, title, ...(p && { path: p }), sections });
  const wpSite = { ...site, pages: [
    wpPage("h", "Home", "/home/"), wpPage("s", "Our Services", "/our-services/"), wpPage("w", "Web", "/services/web/"),
    wpPage("a", "API", "/api/"), wpPage("dup", "Copy", "/our-services/"), wpPage("u", "Café", "/café/"), wpPage("p", "Privacy", "/privacy/"),
    wpPage("n", "Contact", null, [{ type: "form", formId: "contact", heading: "", buttonText: "Send" }]),
  ] };
  assert.deepStrictEqual(await build(wpSite, siteDir, out, {}), { privacy: "/privacy-notice", h: "/", s: "/our-services/", w: "/services/web/",
    a: "/api-2", dup: "/copy", u: "/caf", p: "/privacy/", n: "/contact" });
  assert(read("public/our-services/index.html").includes("<title>Our Services") && fs.existsSync(path.join(out, "public/services/web/index.html")));
  assert.strictEqual(read("public/_redirects"), "/home/ / 301\n/api/ /api-2 301\n/caf%C3%A9/ /caf 301\n", "changed addresses 301, a duplicate path doesn't");
  wpSite.pages[1].title = "What we do";
  assert.strictEqual((await build(wpSite, siteDir, out, {})).s, "/our-services/", "renaming an imported page keeps its address");
  await build(site, siteDir, out, {});
  assert(!fs.existsSync(path.join(out, "public/_redirects")), "no _redirects for app-made pages");

  // Exact copy warns about robots.txt only when search engines are shut out, not AI crawlers (#167).
  const { robotsBlocked } = require("./lib/mirror");
  assert.deepStrictEqual(robotsBlocked("User-agent: *\nDisallow: /\n"), { search: true, others: [] });
  assert.deepStrictEqual(robotsBlocked("User-agent: GPTBot\nDisallow: /\n"), { search: false, others: ["GPTBot"] });
  assert.deepStrictEqual(robotsBlocked("User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"), { search: true, others: [] });
  assert.deepStrictEqual(robotsBlocked("User-agent: *\nDisallow: /wp-admin/\nAllow: /\n\nUser-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: bingbot\nDisallow:\n"), { search: false, others: ["GPTBot", "CCBot"] });
  assert.deepStrictEqual(robotsBlocked("# Disallow: /\n\nuser-agent: ClaudeBot # AI\r\n\r\ndisallow: / # all\r\nUser-agent: *\nDisallow: /private\n"), { search: false, others: ["ClaudeBot"] });

  // Exact-copy import reads WordPress forms' questions from their markup.
  const { formFields } = require("./lib/mirror");
  assert.deepStrictEqual(formFields(`<input type="hidden" name="post_id"><label for="n">Name</label><input id="n" name="f[name]" required>
    <input type="email" name="f[email]" placeholder="Email" aria-required="true"><input type="radio" name="pick" value="a"><input type="radio" name="pick" value="b"><textarea name="msg"></textarea><button type="submit">Go</button>`), [
    { id: "f[name]", label: "Name", type: "text", required: true },
    { id: "f[email]", label: "Email", type: "email", required: true },
    { id: "pick", label: "Pick", type: "choice", required: false },
    { id: "msg", label: "Msg", type: "textarea", required: false },
  ]);
  // Conditional branches (hidden at first) aren't required; checkbox groups are one question; plugin honeypots aren't questions (#22).
  assert.deepStrictEqual(formFields(`<div class="ff-el-group has-conditions"><p><input name="why" required></div>
    <div data-conditional-logic="visible"><input name="phone" type="tel" required></div><label for="c">Colours</label><span><input type="checkbox" name="c[]" id="c-0" required><label for="c-0">Red</label></span><input type="checkbox" name="c[]" id="c-1">
    <select name="size" multiple><option>S</option></select><textarea name="ak_hp_textarea"></textarea><input name="item_1__fluent_sf">`), [
    { id: "why", label: "Why", type: "text", required: false },
    { id: "phone", label: "Phone", type: "tel", required: true },
    { id: "c[]", label: "Colours", type: "choice", required: true },
    { id: "size", label: "Size", type: "choice", required: false },
  ]);
  // Unlabelled questions take a wrapping <label>, aria-labelledby, CF7's <p> text, the placeholder, then a tidied field name (#29).
  assert.deepStrictEqual(formFields(`<h2>Get in touch</h2><p><label>Your name <span>*</span><br><input name="your-name"></label></p>
    <span id="q">Phone number</span><input type="tel" name="tel-1" aria-labelledby="q"><p>Your Message<br><span class="wpcf7-form-control-wrap"><textarea name="your-message">Hi</textarea></span></p>
    <p>Pick one<br><span class="wpcf7-radio"><span><label><input type="radio" name="menu" value="A"><span>A</span></label></span><span><label><input type="radio" name="menu" value="B"><span>B</span></label></span></span></p>
    <p><span class="wpcf7-acceptance"><label><input type="checkbox" name="acceptance-1"><span>I agree to the privacy policy</span></label></span></p>
    <div><input name="city" placeholder="Town"></div><div><input name="f[first_name]"></div><div><select name="budget[]"><option>£1k</option></select></div>`).map((f) => f.label),
    ["Your name *", "Phone number", "Your Message", "Pick one", "I agree to the privacy policy", "Town", "First name", "Budget"]);
  // Builder detection looks for the builder's markup, not just its name (an image called Elementor-Logo.svg).
  const { detectBuilder } = require("./lib/mirror");
  assert.strictEqual(detectBuilder(`<body class="elementor-kit-5"><div data-elementor-type="wp-page">`), "Elementor");
  assert.strictEqual(detectBuilder(`<img src="/wp-content/uploads/Elementor-Logo.svg">`), null);

  // Editable import skips WordPress-only pages and only swaps enquiry forms for ours (#56).
  {
    const { classifyPage } = require("./lib/wordpress");
    const c = (title, html, link = "https://x.test/page/") => classifyPage({ title, html, link });
    assert.deepStrictEqual(c("Register your interest", `<form class="wpcf7-form" method="post" action="/register-your-interest/#wpcf7-f1"><input name="your-email"></form>`), { wpOnly: false, enquiry: true });
    assert.deepStrictEqual(c("Find us", `<form role="search" method="get"><input name="s"></form>`), { wpOnly: false, enquiry: false });
    assert.deepStrictEqual(c("Get in touch", `<form class="woocommerce-form-login" method="post"><input name="username"><input type="password" name="password"></form><form class="wpforms-form" method="post"><input name="wpforms[fields][1]"></form>`), { wpOnly: false, enquiry: true });
    assert.strictEqual(c("Your stuff", "<p>[woocommerce_my_account]</p>").wpOnly, true);
    assert.strictEqual(c("Sign&nbsp;In", "<p>Welcome back</p>").wpOnly, true);
    assert.strictEqual(c("Welcome", "<p>Hi</p>", "https://x.test/lost-password/").wpOnly, true);
    assert.strictEqual(c("Join", `<form method="post"><input name="user_login"><input type="password" name="pass1"></form>`).wpOnly, true);
  }

  // WordPress import with an application password fetches anonymously while it can (#43).
  // Credentials need https; the fakes are http, so rewrite the scheme under fetch.
  {
    const { startWordPress } = require("./test/fakes");
    const { fetchWordPress } = require("./lib/wordpress");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => realFetch(String(url).replace(/^https:/, "http:"), opts);
    try {
      for (const hidden of [false, true]) {
        const wp = await startWordPress({ hidden });
        try {
          const r = await fetchWordPress(wp.url.replace("http:", "https:"), "admin", "abcd efgh");
          const welcome = r.pages.find((p) => p.id === 3).html;
          assert(r.pages.length === 3 && r.name === "Bob&#8217;s Bikes", `hidden=${hidden}: pages fetched`);
          assert.deepStrictEqual(r.skipped, ["Members", "Cart"], `hidden=${hidden}: WordPress-only pages skipped`);
          assert.deepStrictEqual(r.pages.map((p) => p.form), [false, true, false], `hidden=${hidden}: only the contact page gets our form`);
          assert.strictEqual(welcome.includes("already signed in"), hidden, `hidden=${hidden}: welcome rendered as ${hidden ? "admin" : "visitor"}`);
          assert.strictEqual(wp.requests.some(([p, authed]) => authed && !p.endsWith("/users/me")), hidden, `hidden=${hidden}: credentials ${hidden ? "used" : "unused"} for content`);
          assert.strictEqual(r.authenticated, true, `hidden=${hidden}: application password accepted (#141)`);
        } finally { await wp.close(); }
      }
      const wp = await startWordPress({ hidden: true });
      await assert.rejects(fetchWordPress(wp.url, "", ""), /needs a username/);
      await wp.close();
      // A wrong application password on a public site still imports, but doesn't verify ownership.
      const open = await startWordPress();
      assert.strictEqual((await fetchWordPress(open.url.replace("http:", "https:"), "admin", "wrong").finally(open.close)).authenticated, false);
    } finally { globalThis.fetch = realFetch; }
  }

  // Editable import brings in posts as blog-post pages plus a Blog page (#180).
  {
    const { fetchWordPress, withBlog } = require("./lib/wordpress");
    const http = require("node:http");
    const post = (n) => ({ id: 100 + n, title: { rendered: `Post ${n}` }, content: { rendered: `<p>Body ${n}</p>` }, link: `BASE/2026/${String(n).padStart(2, "0")}/post-${n}/`,
      date: `2026-${String(n).padStart(2, "0")}-01T09:30:00`, excerpt: { rendered: `<p>Summary ${n} [&hellip;]</p>\n` },
      _embedded: { author: [{ name: "Bob" }], ...(n === 12 && { "wp:featuredmedia": [{ source_url: "BASE/wp-content/uploads/cover.jpg", alt_text: "Cover" }] }) } });
    let homeClass = "page-template-default", requested = [];
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, "http://x"), base = `http://127.0.0.1:${server.address().port}`;
      requested.push(u.pathname + u.search);
      const send = (body, headers = {}) => { res.writeHead(200, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body).replaceAll("BASE", base)); };
      if (u.pathname === "/wp-json/") return send({ name: "Blog", namespaces: ["wp/v2"] });
      if (u.pathname === "/wp-json/wp/v2/pages") return send([{ id: 1, title: { rendered: "About" }, content: { rendered: "<p>Hi</p>" }, link: "BASE/about/" }, { id: 2, title: { rendered: "News" }, content: { rendered: "" }, link: "BASE/news/" }]);
      // Twelve posts, newest first, six to an API page.
      const page = Number(u.searchParams.get("page"));
      if (u.pathname === "/wp-json/wp/v2/posts") return send([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].slice((page - 1) * 6, page * 6).map(post), { "x-wp-totalpages": "2" });
      res.writeHead(200, { "content-type": "text/html" }); res.end(`<body class="${homeClass}"></body>`);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const r = await fetchWordPress(url);
      assert(requested.some((q) => q.startsWith("/wp-json/wp/v2/posts") && q.includes("page=2") && q.includes("_embed=author")), "posts paginated with author and featured image embedded");
      const posts = r.pages.filter((p) => p.layout === "blog-post");
      assert.deepStrictEqual(posts.map((p) => p.title), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => `Post ${n}`), "every post, newest first");
      assert.deepStrictEqual((({ date, author, excerpt, featuredImage }) => ({ date, author, excerpt, featuredImage }))(posts[0]),
        { date: "2026-12-01", author: "Bob", excerpt: "<p>Summary 12…</p>", featuredImage: { src: `${url}/wp-content/uploads/cover.jpg`, alt: "Cover" } });
      assert(!("featuredImage" in posts[1]));
      assert.deepStrictEqual(r.pages.filter((p) => p.layout === "blog-index").map((p) => p.link), [`${url}/news/`], "the empty News page becomes the blog");
      assert.strictEqual(r.pages.length, 14);
      homeClass = "home blog";
      const home = (await fetchWordPress(url)).pages;
      assert.deepStrictEqual([home[0].layout, home[0].link], ["blog-index", `${url}/`], "posts on the home page: the blog is Home");
      assert.strictEqual(home.filter((p) => p.layout === "blog-index").length, 1);
    } finally { server.close(); }
    // Without a usable page, a new Blog at /blog/ (or /posts/ when that's taken); no posts, no Blog.
    const one = [{ id: 9, title: "P", html: "", link: "https://x.test/2026/p/", layout: "blog-post" }];
    const add = (pages) => withBlog("https://x.test", "", pages, one).find((p) => p.layout === "blog-index")?.link;
    assert.strictEqual(add([{ id: 1, title: "Blog", html: "<p>Our story</p>", link: "https://x.test/about/" }]), "https://x.test/blog/");
    assert.strictEqual(add([{ id: 1, title: "Blog", html: "<p>Our story</p>", link: "https://x.test/blog/" }]), "https://x.test/posts/");
    assert.deepStrictEqual(withBlog("https://x.test", "", [], []), []);

    // Built: posts keep their addresses, the Blog lists them ten to a page.
    const blogSite = { ...site, pages: [{ id: "h", title: "Home", path: "/", sections: [] }, { id: "b", title: "News", path: "/news/", layout: "blog-index", sections: [] },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: `Post ${i}`, path: `/2026/${i}/post-${i}/`, layout: "blog-post", date: `2026-01-${String(i + 1).padStart(2, "0")}`, sections: [] }))] };
    const built = await build(blogSite, siteDir, out, {});
    assert.strictEqual(built.p3, "/2026/3/post-3/");
    assert.strictEqual(built.b, "/news/");
    const page2 = read("public/news/page/2/index.html");
    assert(page2.includes("Post 1<") && page2.includes("Post 0<") && !page2.includes("Post 11<"), "older posts on page 2");
    assert(!fs.existsSync(path.join(out, "public/_redirects")), "no address moved");
  }

  // Import provenance (#141): ownership verification paths, against the fakes.
  {
    const { startWordPress, cloudflareZones } = require("./test/fakes");
    const { verifyOwnership } = require("./lib/mirror");
    const { listZones } = require("./lib/publish");
    const realFetch = globalThis.fetch;
    globalThis.fetch = cloudflareZones(["bobsbikes.co.uk", "other.example"], realFetch);
    try {
      const zones = await listZones("t", "acc");
      for (const host of ["bobsbikes.co.uk", "www.bobsbikes.co.uk", "shop.bobsbikes.co.uk"]) {
        assert.strictEqual((await verifyOwnership(`https://${host}`, { zones })).method, "cloudflare-zone", host);
      }
      assert.strictEqual((await verifyOwnership("https://notbobsbikes.co.uk", { zones })).status, "unverified", "zone match is by domain, not suffix");
    } finally { globalThis.fetch = realFetch; }
    assert.deepStrictEqual((({ status, method }) => ({ status, method }))(await verifyOwnership("https://x.example", { wpAuthenticated: true })), { status: "verified", method: "wordpress-application-password" });
    const token = "0123456789abcdef01234567";
    const wp = await startWordPress({ verifyToken: token });
    try {
      assert.strictEqual((await verifyOwnership(wp.url, { token })).method, "verification-file");
      assert.strictEqual((await verifyOwnership(wp.url, { token: "fedcba9876543210fedcba98" })).status, "unverified", "wrong token");
      assert.strictEqual((await verifyOwnership(wp.url, { token: "../wp-json/" })).status, "unverified", "token format checked");
      assert.strictEqual((await verifyOwnership(wp.url, {})).status, "unverified");
    } finally { await wp.close(); }
  }

  // An Elementor site's kit stylesheet (global colours/fonts) comes back with it (#42).
  {
    const el = await require("./test/fakes").startElementor();
    const r = await require("./lib/wordpress").fetchWordPress(el.url).finally(el.close);
    assert(r.builder === "Elementor" && r.kitCss.includes("--e-global-color-primary:#EE5C44"), "Elementor kit CSS fetched");
  }

  // Exact copy drops the old site's trackers and self-hosts its Google Fonts (#45), Google's hosts pointed at the fake.
  {
    const el = await require("./test/fakes").startElementor();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "sb-el-"));
    const realFetch = globalThis.fetch, asked = [];
    globalThis.fetch = (url, opts) => { asked.push(String(url)); return realFetch(String(url).replace(/^https:\/\/fonts\.(googleapis|gstatic)\.com/, el.url), opts); };
    const r = await require("./lib/mirror").mirrorSite(el.url, out, () => {}).finally(() => { globalThis.fetch = realFetch; return el.close(); });
    const home = fs.readFileSync(path.join(out, "index.html"), "utf8");
    assert.deepStrictEqual(r.removed, ["Google Analytics / Tag Manager", "Facebook pixel"]);
    assert(!/googletagmanager|gtag\(|facebook\.com|fonts\.g/.test(home), "trackers and Google hosts gone from the page");
    assert(asked.includes("https://fonts.googleapis.com/css?family=Sbtest%3A400&display=swap"), "stylesheet URL decoded");
    const local = home.match(/href='(\/google-fonts\/\w+\.css)'/)[1];
    assert.strictEqual(fs.readFileSync(path.join(out, local), "utf8"), "@font-face{font-family:'Sbtest';src:url(/google-fonts/s/sbtest/v1/a.woff2) format('woff2')}");
    assert.strictEqual(fs.readFileSync(path.join(out, "google-fonts/s/sbtest/v1/a.woff2"), "utf8"), "GOOGLEFONT");
    // Page-address tags, robots.txt and sitemap.xml: root-relative in the copy, absolute on the published hostname (#115).
    const about = fs.readFileSync(path.join(out, "about/index.html"), "utf8");
    assert(about.includes('<link rel="canonical" href="/">') && about.includes('<meta property="og:url" content="/about/">') && about.includes('<meta property="og:image" content="/wp-content/uploads/2024/01/hero.png">') && about.includes('content="https://cdn.example/x.png"'));
    assert.strictEqual(fs.readFileSync(path.join(out, "robots.txt"), "utf8"), "User-agent: *\nDisallow: /wp-admin/\n\nSitemap: https://other.example/s.xml\n\nSitemap: /sitemap.xml\n");
    assert.strictEqual(fs.readFileSync(path.join(out, "sitemap.xml"), "utf8"), '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>/</loc><lastmod>2024-01-01</lastmod></url>\n<url><loc>/about/</loc></url>\n</urlset>\n');
    const elDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-elsite-")), elBuilt = fs.mkdtempSync(path.join(os.tmpdir(), "sb-elout-"));
    fs.cpSync(out, path.join(elDir, "mirror"), { recursive: true });
    await build({ ...site, mirror: {}, forms: [], pages: r.pages.map((p, i) => ({ id: `m${i}`, title: p.title, mirror: p.path, file: p.file, sections: [] })) }, elDir, elBuilt, { hostname: "new.example" });
    const pub = (f) => fs.readFileSync(path.join(elBuilt, "public", f), "utf8");
    assert(pub("about/index.html").includes('<link rel="canonical" href="https://new.example/">') && pub("about/index.html").includes('content="https://new.example/about/"') && pub("about/index.html").includes('content="https://new.example/wp-content/uploads/2024/01/hero.png"'));
    assert(pub("robots.txt").endsWith("Sitemap: https://new.example/sitemap.xml\n") && pub("sitemap.xml").includes("<loc>https://new.example/about/</loc>"));
  }

  // Exact copy of a WordPress in a subfolder copies that folder only, with `/` redirecting to it.
  const sub = await require("./test/fakes").startSubfolder();
  const subOut = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sub-"));
  const copied = await require("./lib/mirror").mirrorSite(`${sub.url}/blog`, subOut, () => {}).finally(sub.close);
  assert.deepStrictEqual(copied.pages.map((p) => [p.path, p.title, p.file]), [["/blog/", "Home", "blog/index.html"], ["/blog/about/", "About", "blog/about/index.html"]]);
  assert.deepStrictEqual(sub.forbidden, []);
  assert(fs.existsSync(path.join(subOut, "blog/wp-content/uploads/a.png")) && fs.readFileSync(path.join(subOut, "404.html"), "utf8").includes("No such post"));
  assert.strictEqual(fs.readFileSync(path.join(subOut, "_redirects"), "utf8"), "/blog/old/ /blog/about/ 301\n/ /blog/ 301\n");

  // Syntax-check every script, including the renderer ones nothing above loads.
  // www redirect against a fake Cloudflare API: `zone` holds the existing www records and redirect rules.
  const { ensureWwwRedirect } = require("./lib/publish");
  const realFetch = globalThis.fetch;
  const runRedirect = async (zone, label = "") => {
    const calls = [], logs = [];
    globalThis.fetch = async (url, { method, body }) => {
      calls.push({ method, url: url.replace("https://api.cloudflare.com/client/v4", ""), body: body && JSON.parse(body) });
      const result = method !== "GET" ? {} : url.includes("dns_records") ? zone.records : zone.rules && { rules: zone.rules };
      return { status: 200, json: async () => (result ? { success: true, result } : { success: false, errors: [{ message: "not found" }] }) };
    };
    await ensureWwwRedirect("t", { zoneId: "z1", zoneName: "bob.com", label }, (l) => logs.push(l));
    return { writes: calls.filter((c) => c.method !== "GET"), logs: logs.join("") };
  };
  let r = await runRedirect({ records: [] });
  assert.deepStrictEqual(r.writes[0], { method: "POST", url: "/zones/z1/dns_records", body: { type: "CNAME", name: "www.bob.com", content: "bob.com", ttl: 1, proxied: true, comment: "PhaseN Site Builder: redirects to the apex" } });
  assert.deepStrictEqual(r.writes[1].url, "/zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint");
  assert.deepStrictEqual(r.writes[1].body.rules[0], { ref: "sitebuilder_www_to_apex", description: "Redirect www.bob.com to bob.com",
    expression: '(http.host eq "www.bob.com")', action: "redirect",
    action_parameters: { from_value: { status_code: 301, preserve_query_string: true, target_url: { expression: 'concat("https://bob.com", http.request.uri.path)' } } } });
  r = await runRedirect({ records: [{ type: "A", content: "1.2.3.4" }], rules: [{ ref: "theirs" }] });
  assert(!r.writes.length && r.logs.includes("already has a DNS record") && r.logs.includes("already has redirect rules"), "existing www record/rules untouched");
  r = await runRedirect({ records: [{ type: "CNAME", content: "bob.com", proxied: true }], rules: [{ ref: "sitebuilder_www_to_apex" }] });
  assert(!r.writes.length && !r.logs, "republish is a no-op");
  r = await runRedirect({ records: [], rules: [] });
  assert(r.writes[1]?.method === "PUT", "empty entrypoint ruleset gets the rule");
  r = await runRedirect({ records: [], rules: [] }, "shop");
  assert(!r.writes.length && !r.logs, "subdomain sites get no www redirect (#135)");

  // Subdomains (#135): hostname, migration, label validation, and the Turnstile/route/warning requests.
  const pub135 = require("./lib/publish");
  assert.deepStrictEqual(pub135.siteDomain({ id: "z1", name: "bob.com" }), { zoneId: "z1", zoneName: "bob.com", label: "" }, "pre-#135 domain migrated");
  assert.deepStrictEqual(pub135.siteDomain({ zoneId: "z1", zoneName: "bob.com" }), { zoneId: "z1", zoneName: "bob.com", label: "" });
  assert(pub135.siteDomain(null) === null);
  assert(pub135.domainHostname({ zoneName: "bob.com", label: "" }) === "bob.com" && pub135.domainHostname({ zoneName: "bob.com", label: "shop.eu" }) === "shop.eu.bob.com");
  for (const ok of ["", "shop", "a-b", "x1.shop", "a".repeat(63)]) assert(!pub135.labelError(ok, "bob.com"), ok);
  for (const bad of ["Shop", "-shop", "shop-", "sh_op", "shop..eu", ".shop", "shop.", "a".repeat(64), "sh op", "*.x", `${"a".repeat(60)}.`.repeat(5) + "a"]) assert(pub135.labelError(bad, "bob.com"), bad);
  const cfCalls = [];
  const cfStub = (routes) => async (url, { method, body }) => {
    url = url.replace("https://api.cloudflare.com/client/v4", "");
    cfCalls.push({ method, url, body: body && JSON.parse(body) });
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    return { status: 200, json: async () => ({ success: true, result: hit ? hit[1] : {} }) };
  };
  globalThis.fetch = cfStub({ "/challenges/widgets": { sitekey: "sk", secret: "sec" } });
  assert.deepStrictEqual(await pub135.ensureTurnstile("t", "a1", "Bob", "shop.bob.com"), { sitekey: "sk", secret: "sec", hostname: "shop.bob.com" });
  assert.deepStrictEqual(cfCalls.pop(), { method: "POST", url: "/accounts/a1/challenges/widgets", body: { name: "Bob website", domains: ["shop.bob.com"], mode: "managed" } });
  await pub135.ensureTurnstile("t", "a1", "Bob", "shop.bob.com", { sitekey: "sk", secret: "sec", hostname: "bob.com" });
  assert.deepStrictEqual(cfCalls.pop(), { method: "PUT", url: "/accounts/a1/challenges/widgets/sk", body: { name: "Bob website", domains: ["shop.bob.com"], mode: "managed" } }, "widget follows a hostname change");
  const shop = { zoneId: "z1", zoneName: "bob.com", label: "shop" };
  globalThis.fetch = cfStub({ "/workers/domains": [], "/dns_records": [{ type: "A" }, { type: "A" }] });
  cfCalls.length = 0;
  let w = await pub135.hostnameWarnings("t", "a1", shop, "bob-1");
  assert.deepStrictEqual(cfCalls.map((c) => c.url), ["/accounts/a1/workers/domains?hostname=shop.bob.com", "/zones/z1/dns_records?name=shop.bob.com"]);
  assert(w.length === 1 && w[0].includes("shop.bob.com already has DNS records (A)"), w);
  globalThis.fetch = cfStub({ "/workers/domains": [{ hostname: "shop.bob.com", service: "someone-else" }] });
  w = await pub135.hostnameWarnings("t", "a1", shop, "bob-1");
  assert(w.length === 1 && w[0].includes("another Cloudflare Worker (someone-else)"), w);
  globalThis.fetch = cfStub({ "/workers/domains": [{ hostname: "shop.bob.com", service: "bob-1" }], "/dns_records": [{ type: "AAAA" }] });
  assert.deepStrictEqual(await pub135.hostnameWarnings("t", "a1", shop, "bob-1"), [], "this site's own Custom Domain isn't a warning");
  globalThis.fetch = async () => ({ status: 403, json: async () => ({ success: false, errors: [] }) });
  assert.deepStrictEqual(await pub135.hostnameWarnings("t", "a1", shop, "bob-1"), [], "lookups the token can't make are skipped");
  globalThis.fetch = realFetch;

  // Unpublish (#71): best-effort, only removes what publishing made, keeps failures for a retry.
  const writes = [];
  globalThis.fetch = async (url, { method }) => {
    url = url.replace(/^https:\/\/api\.(cloudflare\.com\/client\/v4|resend\.com)/, "");
    const reply = (status, result) => ({ status, ok: status < 300, json: async () => (status < 300 ? { success: true, result } : { success: false, errors: [{ message: "boom" }], message: "gone" }) });
    if (method !== "GET") writes.push(`${method} ${url}`);
    if (url.includes("/challenges/widgets/")) return reply(500);
    if (url.startsWith("/api-keys/")) return reply(404);
    if (method !== "GET") return reply(200, {});
    if (url.includes("/workers/domains")) return reply(200, [{ id: "d1" }]);
    if (url.includes("dns_records")) return reply(200, [{ id: "r1", comment: "PhaseN Site Builder: redirects to the apex" }, { id: "r2", comment: "theirs" }]);
    return reply(200, { id: "rs1", rules: [{ id: "x2", ref: "theirs" }, { id: "x1", ref: "sitebuilder_www_to_apex" }] });
  };
  const logs = [];
  const { unpublish } = require("./lib/publish");
  const res = await unpublish("t", "k", { accountId: "a1", worker: "bob-1a2b", url: "https://bob.com", publishedAt: "x", www: { id: "z1", name: "bob.com" },
    turnstile: { sitekey: "s1" }, sendingKey: "sealed", sendingKeyId: "k1", sendingKeyDomain: "dom" }, (l) => logs.push(l));
  assert.deepStrictEqual(writes, ["DELETE /accounts/a1/workers/domains/d1", "DELETE /accounts/a1/workers/scripts/bob-1a2b?force=true",
    "DELETE /zones/z1/dns_records/r1", "DELETE /zones/z1/rulesets/rs1/rules/x1", "DELETE /accounts/a1/challenges/widgets/s1", "DELETE /api-keys/k1"]);
  assert.deepStrictEqual(res, { state: { accountId: "a1", turnstile: { sitekey: "s1" } }, failed: ["the form spam check (Turnstile widget)"] }, "failed step kept for retry, 404 counts as removed");
  assert(logs.join("").includes("Couldn't remove the form spam check") && logs.join("").includes("Already gone: the form email key"));
  globalThis.fetch = realFetch;

  // Hostname changes (#139): old Custom Domain, old apex's www and a 301 from the old hostname, all best-effort.
  const moveStub = (routes, writes) => async (url, { method, body }) => {
    url = url.replace("https://api.cloudflare.com/client/v4", "");
    if (method !== "GET") { writes.push([`${method} ${url}`, body && JSON.parse(body)]); return { status: 200, json: async () => ({ success: true, result: {} }) }; }
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (hit?.[1] === 403) return { status: 403, json: async () => ({ success: false, errors: [{ message: "denied" }] }) };
    return { status: 200, json: async () => ({ success: true, result: hit ? hit[1] : [] }) };
  };
  const move = async (state, to, www, redirect, routes) => {
    const writes = [], logs = [];
    globalThis.fetch = moveStub(routes, writes);
    await pub135.leaveHostname("t", state, to, www, redirect, (l) => logs.push(l));
    return { writes, logs: logs.join(""), state };
  };
  const apexRoutes = {
    "/workers/domains?service=bob-1": [{ id: "d1", hostname: "bob.com" }, { id: "d2", hostname: "shop.bob.com" }],
    "/zones?account.id=a1": [{ id: "z0", name: "com.example" }, { id: "z1", name: "bob.com" }],
    "dns_records?name=www.bob.com": [{ id: "r1", comment: "PhaseN Site Builder: redirects to the apex" }, { id: "r2", comment: "theirs" }],
    "dns_records?name=bob.com": [],
    "/entrypoint": { id: "rs1", rules: [{ id: "x1", ref: "sitebuilder_www_to_apex" }] },
  };
  let mv = await move({ accountId: "a1", worker: "bob-1", url: "https://bob.com", www: { id: "z1", name: "bob.com" } }, "shop.bob.com", null, true, apexRoutes);
  assert.deepStrictEqual(mv.writes.map((w) => w[0]), ["DELETE /zones/z1/dns_records/r1", "DELETE /zones/z1/rulesets/rs1/rules/x1", "DELETE /accounts/a1/workers/domains/d1",
    "POST /zones/z1/rulesets/rs1/rules", "POST /zones/z1/dns_records"], mv.logs);
  assert.deepStrictEqual(mv.writes[3][1].ref, "sitebuilder_moved_bob_com");
  assert.deepStrictEqual(mv.writes[3][1].action_parameters.from_value.target_url, { expression: 'concat("https://shop.bob.com", http.request.uri.path)' });
  assert.deepStrictEqual(mv.writes[4][1], { type: "AAAA", name: "bob.com", content: "100::", ttl: 1, proxied: true, comment: "PhaseN Site Builder: redirects to the website's new address" });
  assert.deepStrictEqual(mv.state, { accountId: "a1", worker: "bob-1", url: "https://bob.com", moved: [{ zoneId: "z1", hostname: "bob.com" }] }, "old www dropped, redirect recorded");
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://bob.com", www: { id: "z1", name: "bob.com" } }, "bob.com", { id: "z1", name: "bob.com" }, true, apexRoutes);
  assert(!mv.writes.length && mv.state.www.id === "z1", "same hostname: nothing removed");
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://shop.bob.com" }, "bob.com", { id: "z1", name: "bob.com" }, false, apexRoutes);
  assert.deepStrictEqual(mv.writes.map((w) => w[0]), ["DELETE /accounts/a1/workers/domains/d2"]);
  assert(mv.state.www.id === "z1" && !mv.state.moved && mv.logs.includes("redirecting it is turned off"), mv.logs);
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://bob-1.x.workers.dev" }, "bob.com", null, true, apexRoutes);
  assert(!mv.writes.length && mv.logs.includes("workers.dev address, which can't redirect"), mv.logs);
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://old.gone.com" }, "bob.com", null, true, apexRoutes);
  assert(!mv.writes.length && !mv.state.moved && mv.logs.includes("old.gone.com isn't on this Cloudflare account"), mv.logs);
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://bob.com" }, "shop.bob.com", null, true, { ...apexRoutes, "dns_records?name=bob.com": [{ id: "r9", comment: "" }] });
  assert(mv.writes.length === 1 && !mv.state.moved && mv.logs.includes("still has other DNS records"), mv.logs);
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://bob.com" }, "shop.bob.com", null, true, { ...apexRoutes, "/entrypoint": { id: "rs1", rules: [{ id: "y", ref: "theirs" }] } });
  assert(mv.writes.length === 1 && !mv.state.moved && mv.logs.includes("already has redirect rules"), mv.logs);
  mv = await move({ accountId: "a1", worker: "bob-1", url: "https://bob.com", www: { id: "z1", name: "bob.com" } }, "shop.bob.com", null, true, { ...apexRoutes, "dns_records?name=www.bob.com": 403, "/workers/domains?service=bob-1": 403 });
  assert(mv.logs.includes("Couldn't remove the www redirect for bob.com (Cloudflare: denied)") && mv.logs.includes("Couldn't detach bob.com") && mv.state.moved, "failures are logged, not thrown");
  // Moving back to a hostname that redirects: the redirect goes first. Taking offline removes any left.
  const movedBack = { moved: [{ zoneId: "z1", hostname: "bob.com" }, { zoneId: "z2", hostname: "old.net" }] }, mvWrites = [];
  globalThis.fetch = moveStub({ "dns_records?name=bob.com": [{ id: "m1", comment: "PhaseN Site Builder: redirects to the website's new address" }],
    "/entrypoint": { id: "rs1", rules: [{ id: "x1", ref: "sitebuilder_www_to_apex" }, { id: "x2", ref: "sitebuilder_moved_bob_com" }] } }, mvWrites);
  await pub135.reclaimHostname("t", movedBack, "bob.com", () => {});
  assert.deepStrictEqual(mvWrites.map((w) => w[0]), ["DELETE /zones/z1/dns_records/m1", "DELETE /zones/z1/rulesets/rs1/rules/x2"]);
  assert.deepStrictEqual(movedBack.moved, [{ zoneId: "z2", hostname: "old.net" }]);
  mvWrites.length = 0;
  globalThis.fetch = moveStub({ "/entrypoint": { id: "rs2", rules: [{ id: "x3", ref: "sitebuilder_moved_old_net" }] } }, mvWrites);
  const offMoved = await pub135.unpublish("t", "k", { accountId: "a1", ...movedBack }, () => {});
  assert.deepStrictEqual(mvWrites.map((w) => w[0]), ["DELETE /zones/z2/rulesets/rs2/rules/x3"]);
  assert.deepStrictEqual(offMoved, { state: { accountId: "a1" }, failed: [] });
  globalThis.fetch = realFetch;

  // Form inbox D1 API (#75), against a stub: reuse by name, create otherwise, table made either way.
  const pub = require("./lib/publish");
  const d1Calls = [];
  const d1Stub = (dbs) => async (url, { method, body }) => {
    url = url.replace("https://api.cloudflare.com/client/v4", "");
    d1Calls.push(`${method} ${url}${body ? ` ${body}` : ""}`);
    const result = url.endsWith("/query") ? [{ results: [{ id: 1 }], success: true }] : method === "POST" ? { uuid: "new-db" } : method === "DELETE" ? {} : dbs;
    return { status: 200, json: async () => ({ success: true, result }) };
  };
  globalThis.fetch = d1Stub([{ name: "bob-1a2b-inboxx", uuid: "no" }, { name: "bob-1a2b-inbox", uuid: "old-db" }]);
  assert.deepStrictEqual(await pub.ensureD1("t", "a1", "bob-1a2b"), { id: "old-db", name: "bob-1a2b-inbox" });
  assert(d1Calls[0] === "GET /accounts/a1/d1/database?name=bob-1a2b-inbox" && /^POST \/accounts\/a1\/d1\/database\/old-db\/query .*CREATE TABLE IF NOT EXISTS messages/.test(d1Calls[1]), d1Calls);
  d1Calls.length = 0;
  globalThis.fetch = d1Stub([]);
  assert.deepStrictEqual(await pub.ensureD1("t", "a1", "bob-1a2b"), { id: "new-db", name: "bob-1a2b-inbox" });
  assert(d1Calls[1] === 'POST /accounts/a1/d1/database {"name":"bob-1a2b-inbox"}', d1Calls);
  d1Calls.length = 0;
  assert.deepStrictEqual(await pub.ensureD1("t", "a1", "bob-1a2b", { id: "kept", name: "bob-1a2b-inbox" }), { id: "kept", name: "bob-1a2b-inbox" });
  assert(d1Calls.length === 1, "recorded database reused without a lookup");
  assert.deepStrictEqual(await pub.d1Query("t", "a1", "kept", "SELECT 1"), [{ id: 1 }]);
  d1Calls.length = 0;
  const off = await pub.unpublish("t", "k", { accountId: "a1", d1: { id: "kept", name: "x" } }, () => {});
  assert(d1Calls.includes("DELETE /accounts/a1/d1/database/kept") && !off.state.d1 && !off.failed.length, "taking offline deletes the inbox");
  globalThis.fetch = async (url) => ({ status: url.includes("/d1/") ? 403 : 200, json: async () => (url.includes("/d1/") ? { success: false, errors: [] } : { success: true, result: [{ id: "a1", name: "A" }] }) });
  assert((await pub.checkCloudflareToken("t")).warnings.some((w) => w.includes("D1")), "missing D1 permission warned");
  globalThis.fetch = realFetch;
  const csv = pub.messagesCsv([
    { id: 2, form: "f1", fields: JSON.stringify([{ label: "Name", value: "=HYPERLINK(1)" }, { label: "Message", value: 'Hi, "there"\nbye' }]), created_at: "2026-10-24 10:00:00", email_status: "failed (403)" },
    { id: 1, form: "gone", fields: JSON.stringify([{ label: "Phone", value: "0123" }]), created_at: "2026-10-23 09:00:00", email_status: "sent" },
  ], { f1: "Contact" });
  assert.strictEqual(csv, 'Received (UTC),Form,Email,Name,Message,Phone\r\n2026-10-24 10:00:00,Contact,failed (403),\'=HYPERLINK(1),"Hi, ""there""\nbye",\r\n2026-10-23 09:00:00,gone,sent,,,0123\r\n');

  // #182: nothing copyleft gets packaged; sharp/libvips (LGPL) stays excluded by build.files.
  const licences = require("./scripts/licences");
  const shipped = licences.packaged();
  assert.deepStrictEqual(licences.copyleft(shipped), [], "copyleft production dependency would be packaged");
  assert(shipped.some((p) => p.name === "wrangler") && !shipped.some((p) => /^node_modules\/(@img|sharp)\b/.test(p.key)));
  for (const [lic, want] of [["MIT", false], ["(MIT OR GPL-3.0)", false], ["Apache-2.0 AND LGPL-3.0-or-later", true],
    ["GPL-2.0 OR AGPL-3.0", true], ["MPL-2.0", true], ["BSD-3-Clause", false]]) assert.strictEqual(licences.isCopyleft(lic), want, lic);

  const { bump } = require("./scripts/release-bump");
  for (const [from, to, want] of [["0.3.0", "0.3.1", "patch"], ["0.3.9", "0.3.10", "patch"], ["0.3.1", "0.4.0", "minor"],
    ["0.4.0", "1.0.0", "major"], ["1.2.3", "1.2.3", "major"], ["1.2.3", "1.2.4-beta.1", "major"], ["", "1.0.1", "major"]]) {
    assert.strictEqual(bump(from, to), want, `${from} -> ${to}`);
  }
  // #97: never merge onto a main that moved after regression ran.
  const { staleReason } = require("./scripts/release-bump");
  const ok = { startMain: "m1", main: "m1", base: "m1", tested: "h1", head: "h1", containsMain: "true" };
  assert.strictEqual(staleReason(ok), "");
  for (const [change, want] of [[{ main: "m2", base: "m2" }, "main moved"], [{ base: "m0" }, "base"], [{ head: "h2" }, "head moved"],
    [{ containsMain: "false" }, "isn't based on main"], [{ startMain: "" }, "missing"], [{ tested: undefined }, "missing"]]) {
    assert(staleReason({ ...ok, ...change }).includes(want), `stale: ${JSON.stringify(change)}`);
  }
  // #111: a PR the gate refused as stale is re-gated without a new push.
  const { gateReason } = require("./scripts/release-bump");
  const main = "refs/heads/main";
  assert(gateReason({ event: "push", ref: main, prsCreated: "true" }));
  assert.strictEqual(gateReason({ event: "push", ref: main, prsCreated: "false", labels: ["regression-failed"] }), "");
  assert(gateReason({ event: "schedule", ref: main, prsCreated: "false", labels: ["autorelease: pending", "regate"] }));
  assert.strictEqual(gateReason({ event: "schedule", ref: main, prsCreated: "false", labels: [""] }), "");
  assert(gateReason({ event: "workflow_dispatch", ref: main, prsCreated: "false", labels: ["needs-approval"] }));
  assert.strictEqual(gateReason({ event: "workflow_dispatch", ref: "refs/heads/fix/x", prsCreated: "false" }), "");

  // Theme packages: the bundled ones are valid, bad ones are caught, and a
  // font stack instead of a font id still loads.
  const { validateTheme, validateAll } = require("./lib/theme-validate");
  const { loadThemes, themes, fonts } = require("./lib/themes");
  assert.deepStrictEqual(validateAll("themes"), {});
  assert.deepStrictEqual(Object.keys(themes), ["clean", "bold", "elegant"]);
  assert(read("public/styles.css").includes("--font: Georgia") && read("public/styles.css").includes("text-transform"), "bold theme.css + serif font");
  // Black/white text is whichever contrasts more, and every bundled theme's
  // defaults meet WCAG AA (4.5:1) for text, links, buttons and the header/hero.
  const { contrastRatio, contrastText } = require("./lib/build");
  assert.strictEqual(contrastText("#f97316"), "#111111", "orange gets dark text");
  assert.strictEqual(contrastText("#1e3a8a"), "#ffffff", "navy gets white text");
  for (const [id, { colors: c }] of Object.entries(themes)) {
    for (const [what, fg, bg] of [["text", c.text, c.background], ["links", c.primary, c.background],
      ["button text", contrastText(c.accent), c.accent], ["header text", contrastText(c.primary), c.primary]]) {
      assert(contrastRatio(fg, bg) >= 4.5, `${id} ${what}: ${contrastRatio(fg, bg).toFixed(2)}:1`);
    }
  }
  const tdir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-themes-"));
  const pkg = (id, json, css) => {
    fs.mkdirSync(path.join(tdir, id));
    fs.writeFileSync(path.join(tdir, id, "theme.json"), JSON.stringify(json));
    fs.writeFileSync(path.join(tdir, id, "theme.css"), css);
  };
  pkg("mono", { label: "Mono", about: "x", font: '"Courier New", monospace', colors: themes.clean.colors }, ":root { --radius: 0; }");
  assert.deepStrictEqual(validateTheme(path.join(tdir, "mono")), []);
  assert.strictEqual(fonts[loadThemes(tdir).mono.font].stack, '"Courier New", monospace');
  pkg("Bad_Id", { label: "", about: "x", font: "x;}body{", colors: { background: "red" }, extra: 1 }, '@import "x.css"; a{background:url(javascript:alert(1))}</style>');
  fs.writeFileSync(path.join(tdir, "Bad_Id", "evil.js"), "");
  fs.writeFileSync(path.join(tdir, "Bad_Id", "preview.png"), "not a png");
  const errs = validateTheme(path.join(tdir, "Bad_Id")).join("\n");
  for (const want of ["folder name", "evil.js", '"label"', '"font"', "colors.background", "colors.accent", '"extra"', "@import", "javascript:", "'<'", "not a PNG"]) assert(errs.includes(want), want);

  // Theme sources (#58), against the fake GitHub API in test/fakes.js.
  const ts = require("./lib/theme-sources");
  assert.deepStrictEqual(ts.parseSource("https://github.com/Acme/Themes.x/"), { owner: "Acme", repo: "Themes.x", folder: null, branch: null, spec: "Acme/Themes.x" });
  assert.strictEqual(ts.parseSource(" acme/t/a/b@feature/x ").spec, "acme/t/a/b@feature/x");
  for (const bad of ["acme", "acme/t x", "../x", "acme/t/../y", "a/b?c"]) assert.throws(() => ts.parseSource(bad), /owner\/repo/, bad);
  const fakeGh = await require("./test/fakes").startGitHub();
  try {
    const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sb-theme-cache-"));
    const opts = { cacheRoot, api: fakeGh.url };
    const pub = await ts.fetchSource(ts.PUBLIC_SOURCE, opts);
    assert.deepStrictEqual(Object.keys(pub.themes).sort(), ["broken", "clean", "retro"]);
    assert.deepStrictEqual(pub.themes.retro.errors, []);
    assert(pub.themes.retro.preview.startsWith("data:image/png;base64,") && pub.themes.retro.label === "Retro");
    assert(pub.themes.broken.errors.join().includes("evil.js") && !pub.themes.broken.label);
    await assert.rejects(ts.fetchSource(fakeGh.privateSpec, opts), /private repository, add an access token/);
    await assert.rejects(ts.fetchSource(fakeGh.privateSpec, { ...opts, token: "wrong" }), /didn't accept the access token.*sign out and sign in again/);
    // A rejected token (e.g. an expired sign-in) doesn't block a public repo (#251).
    assert.deepStrictEqual(Object.keys((await ts.fetchSource(ts.PUBLIC_SOURCE, { ...opts, token: "expired" })).themes).sort(), ["broken", "clean", "retro"]);
    await assert.rejects(ts.fetchSource("limited/repo", opts), /download limit/);
    await assert.rejects(ts.fetchSource(`${ts.PUBLIC_SOURCE}/nope`, opts), /no theme folders in nope\//);
    fakeGh.requests.length = 0;
    const priv = await ts.fetchSource(fakeGh.privateSpec, { ...opts, token: fakeGh.token });
    assert.deepStrictEqual(Object.keys(priv.themes), ["night"]);
    assert.deepStrictEqual(priv.themes.night.errors, []);
    assert.deepStrictEqual(fakeGh.requests.map(([host, , auth]) => [host === fakeGh.host, auth]), [[true, `Bearer ${fakeGh.token}`], [false, null]], "token only sent to the API host");
    await assert.rejects(ts.installTheme(ts.PUBLIC_SOURCE, "broken", cacheRoot, siteDir), /isn't available/);
    await ts.installTheme(fakeGh.privateSpec, "night", cacheRoot, siteDir);
    fs.rmSync(cacheRoot, { recursive: true }); // builds never need the cache
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), "sb-themed-"));
    await build({ ...site, theme: "night", themeSource: fakeGh.privateSpec, font: "theme-night" }, siteDir, out2);
    const css = fs.readFileSync(path.join(out2, "public/styles.css"), "utf8");
    assert(css.includes("night-theme-css") && css.includes('--font: "Courier New", monospace'), "site-local theme CSS and font stack");
  } finally {
    await fakeGh.close();
  }

  // Theme Builder (#130): every control combination makes a valid package whose
  // controls read back, the defaults pass contrast, and a saved theme builds.
  {
    const tb = require("./lib/theme-builder");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-local-themes-"));
    const combos = Object.entries(tb.CHOICES).flatMap(([k, opts]) => Object.keys(opts).map((v) => ({ [k]: v })));
    for (const [i, extra] of [{ radius: 0 }, { radius: 99, font: "serif" }, { font: '"Courier New", monospace' }, ...combos].entries()) {
      const controls = tb.clean({ ...extra, colors: themes.clean.colors, css: ".hero { letter-spacing: .01em; }" });
      assert.deepStrictEqual(await tb.writeTheme(path.join(root, `c${i}`), controls), [], JSON.stringify(extra));
      const back = tb.parse(JSON.parse(fs.readFileSync(path.join(root, `c${i}`, "theme.json"), "utf8")), fs.readFileSync(path.join(root, `c${i}`, "theme.css"), "utf8"));
      assert.deepStrictEqual(back, { ...controls, id: undefined, css: ".hero { letter-spacing: .01em; }\n" }, JSON.stringify(extra));
    }
    assert.strictEqual(tb.clean({ radius: 99 }).radius, 32, "radius clamped");
    assert.deepStrictEqual(tb.clean({ header: "evil", colors: { text: "red" }, font: "x;}body{" }), tb.clean({}), "bad controls fall back to defaults");
    assert.deepStrictEqual(tb.warnings({}), [], "default colours pass WCAG AA");
    assert.match(tb.warnings({ colors: { background: "#ffffff", text: "#bbbbbb" } }).join(), /Text may be hard to read/);
    assert.match(tb.warnings({ button: "outline", colors: { background: "#ffffff", accent: "#ffee00" } }).join(), /Buttons may be hard to read/);
    assert(!tb.parse({ label: "x" }, ":root { --radius: 8px; }"), "a hand-written theme isn't editable as controls");
    assert.match((await tb.writeTheme(path.join(root, "bad"), { css: "@import url(x.css);" })).join(), /@import/);
    const lroot = path.join(root, "local");
    const a = await tb.saveLocal(lroot, { label: "Sunny Days!", header: "bar" }, null);
    assert.deepStrictEqual(a, { id: "sunny-days", errors: [] });
    assert.strictEqual((await tb.saveLocal(lroot, { label: "Sunny Days!" })).id, "sunny-days-2", "new themes never overwrite");
    assert.strictEqual((await tb.saveLocal(lroot, { id: "sunny-days", label: "Sunny" })).id, "sunny-days");
    assert.deepStrictEqual((await tb.saveLocal(lroot, { id: "sunny-days", css: "</style>" })).errors, ["theme.css: '<' is not allowed (no HTML in theme.css)"]);
    const list = await tb.listLocal(lroot);
    assert.deepStrictEqual(Object.keys(list), ["sunny-days", "sunny-days-2"], "failed save left nothing behind");
    assert.strictEqual(list["sunny-days"].version, "1.0.1", "saving again bumps the version");
    assert.strictEqual(list["sunny-days"].controls.header, "left");
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-local-site-"));
    await tb.installLocal(lroot, "sunny-days-2", sdir);
    await assert.rejects(tb.installLocal(lroot, "../x", sdir), /isn't in your themes/);
    const out3 = fs.mkdtempSync(path.join(os.tmpdir(), "sb-local-built-"));
    await build({ ...site, theme: "sunny-days-2", themeSource: "local", font: "sans", colors: list["sunny-days-2"].colors }, sdir, out3);
    assert(fs.readFileSync(path.join(out3, "public/styles.css"), "utf8").includes("/* theme-builder "), "site built with a local theme");
    const started = await tb.fromSite({ ...site, theme: "elegant" }, siteDir, themes);
    assert(started.css.includes("flex-direction: column") && started.font === "serif" && started.colors.primary === "#ffee00" && started.radius === 2 && !started.css.includes("--radius"), "from a website: its CSS, font and colours");
    assert.strictEqual((await tb.fromSite({ ...site, mirror: {} }, siteDir, themes)).css, "", "exact copies: colours and font only");
    const sample = tb.sampleSite({});
    assert.deepStrictEqual([...new Set(sample.pages.flatMap((p) => p.sections.map((s) => s.type)))].sort(), ["form", "gallery", "hero", "richtext", "text"]);

    // Right-click menu (#156): its selector classes are exactly the ones the built markup uses.
    const frameLib = require("./app/theme-builder-frame");
    const fdir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-frame-site-"));
    await tb.writeTheme(path.join(fdir, "theme"), tb.clean({}));
    const every = { ...sample, analyticsId: "G-TEST1", pages: sample.pages.map((p, i) => i ? p : { ...p, sections: [
      ...p.sections.map((s) => (s.type === "hero" ? { ...s, image: { src: "assets/sample-1.svg" } } : s.type === "text" ? { ...s, imageLeft: true } : s)),
      { id: "v", type: "richtext", html: '<div class="video-embed" data-src="https://player.vimeo.com/video/1"></div>' }] }) };
    const fout = fs.mkdtempSync(path.join(os.tmpdir(), "sb-frame-built-"));
    await build(every, fdir, fout, { sitekey: "SITEKEY" });
    const builtClasses = new Set(fs.readdirSync(path.join(fout, "public")).filter((f) => f.endsWith(".html"))
      .flatMap((f) => [...fs.readFileSync(path.join(fout, "public", f), "utf8").matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/))));
    // layout-<id> body classes (#184) are known but not suggested until #171; any other new class must be added to STABLE.
    const layoutClasses = new Set(require("./lib/layouts").LAYOUTS.map((l) => `layout-${l.id}`));
    assert.deepStrictEqual([...builtClasses].sort(), [...frameLib.STABLE, ...[...builtClasses].filter((c) => layoutClasses.has(c))].sort(), "STABLE matches renderPage/renderSection's classes");
    const el = (tag, ...classes) => ({ tag, classes });
    assert.deepStrictEqual(frameLib.candidates([el("h1"), el("div", "wrap"), el("section", "hero", "has-image"), el("main")]), [".hero h1", "main h1", "h1"]);
    assert.deepStrictEqual(frameLib.candidates([el("a", "button", "wp-x"), el("p"), el("div", "wrap"), el("section", "richtext"), el("main")]), [".richtext .button", "main .button", ".button"]);
    assert.deepStrictEqual(frameLib.candidates([el("section", "hero"), el("main")]), ["main .hero", ".hero"]);
    assert.deepStrictEqual(frameLib.candidates([el("p", "elementor-1"), el("div", "x-7")]), ["p"], "unknown classes and ids never used");
    // Advanced CSS rule lookup: comments, strings and nested at-rules don't fool it.
    const adv = '/* .hero h1 { } */\n.x { content: "}{ .hero h1 {"; }\n@media (max-width: 1px) { .hero h1 { color: red } }\n.hero h1, h2 { color: blue }\n.hero  >  h1 {}\n.hero   h1 { color: green; }\n';
    assert.deepStrictEqual(tb.cssRules(adv).map((r) => r.selector), [".x", "@media (max-width: 1px)", ".hero h1,h2", ".hero>h1", ".hero h1"]);
    const found = tb.cssRule(adv, { selectors: ["main h1", ".hero h1"] });
    assert(found.found && found.css === adv && adv.slice(found.start, found.end) === ".hero   h1 { color: green; }", "selects the existing top-level rule");
    const added = tb.cssRule(".a { }\n\n", { selectors: ["main h1", "h1"] });
    assert.deepStrictEqual(added, { css: ".a { }\n\nmain h1 {\n  \n}\n", start: 8, end: 22, cursor: 20, found: false });
    assert.deepStrictEqual(await tb.writeTheme(path.join(root, "rule"), tb.clean({ css: added.css })), [], "an added rule stays valid");

    // Publishing a theme to GitHub (#60), against the fake GitHub in test/fakes.js.
    const gh = require("./lib/github");
    assert.strictEqual(gh.clientId({ env: { SITEBUILDER_GITHUB_CLIENT_ID: " abc " }, dir: root }), "abc");
    assert.strictEqual(gh.clientId({ env: { SITEBUILDER_GITHUB_CLIENT_ID: "abc" }, packaged: true, dir: root }), "", "env ignored when packaged; no config file");
    fs.writeFileSync(path.join(root, "github-config.json"), '{"clientId":"Ov23x"}');
    assert.strictEqual(gh.clientId({ env: {}, packaged: true, dir: root }), "Ov23x");
    const fake = await require("./test/fakes").startGitHub();
    try {
      const opts = { api: fake.url, login: fake.url };
      await assert.rejects(gh.startDeviceFlow({ ...opts, clientId: "wrong", scope: "public_repo" }), /sign-in failed \(unauthorized_client\)/);
      const flow = await gh.startDeviceFlow({ ...opts, clientId: fake.clientId, scope: "public_repo repo" });
      assert.strictEqual(flow.userCode, "WDJB-MJHT");
      await assert.rejects(gh.pollDeviceFlow({ ...opts, ...flow, clientId: fake.clientId, cancelled: () => true }), /cancelled/);
      const { token } = await gh.pollDeviceFlow({ ...opts, ...flow, clientId: fake.clientId, wait: async () => {} });
      assert.strictEqual(token, fake.token);
      assert.strictEqual((await gh.user(fake.url, token)).login, "octo");
      assert(await gh.canPush(fake.url, token, gh.PRIVATE_DEFAULT) && !(await gh.canPush(fake.url, "nope", gh.PRIVATE_DEFAULT)));

      fs.mkdirSync(path.join(lroot, "bad-one"));
      fs.cpSync(path.join(lroot, "sunny-days"), path.join(lroot, "bad-one"), { recursive: true });
      fs.writeFileSync(path.join(lroot, "bad-one", "notes.txt"), "secret");
      await assert.rejects(gh.themeFiles(path.join(lroot, "bad-one")), /can't be published: unexpected file notes.txt/);
      fs.writeFileSync(path.join(lroot, "sunny-days", "preview.png"), require("./test/fakes").PNG);
      const { files, json } = await gh.themeFiles(path.join(lroot, "sunny-days"));
      assert.deepStrictEqual(Object.keys(files).sort(), ["preview.png", "theme.css", "theme.json"]);
      const theme = { id: "sunny-days", files, version: json.version };

      const pushed = await gh.pushTheme({ api: fake.url, token, target: gh.PRIVATE_DEFAULT, ...theme });
      assert.strictEqual(pushed.url, "https://github.com/PhaseN-Digital/phasen-themes-private/tree/main/themes/sunny-days");
      const repoFiles = fake.files(gh.PRIVATE_DEFAULT);
      assert.deepStrictEqual(Object.keys(repoFiles).sort(), ["README.md", "themes/.gitkeep", "themes/sunny-days/preview.png", "themes/sunny-days/theme.css", "themes/sunny-days/theme.json"]);
      assert(repoFiles["themes/sunny-days/preview.png"].equals(files["preview.png"]), "binary preview intact");
      await assert.rejects(gh.pushTheme({ api: fake.url, token, target: "octo/readonly", ...theme }), /can't write to octo\/readonly/);
      await assert.rejects(gh.pushTheme({ api: fake.url, token, target: "octo/missing", ...theme }), /Couldn't find octo\/missing/);

      const pr = await gh.submitTheme({ api: fake.url, token, ...theme, label: json.label, about: json.about, wait: async () => {} });
      assert.strictEqual(pr.url, "https://github.com/PhaseN-Digital/phasen-sitebuilder-themes/pull/1");
      const [p] = fake.pulls;
      assert(p.title === "Add theme: Sunny" && p.base === "main" && p.head.startsWith("octo:theme-sunny-days-1-0-1-") && p.body.startsWith(json.about), p);
      assert.deepStrictEqual(Object.keys(p.files).filter((f) => f.startsWith("themes/sunny-days/")).sort(), ["themes/sunny-days/preview.png", "themes/sunny-days/theme.css", "themes/sunny-days/theme.json"]);
      assert(!Object.keys(fake.files("PhaseN-Digital/phasen-sitebuilder-themes")).some((f) => f.includes("sunny")), "upstream itself untouched");
      assert((await gh.submitTheme({ api: fake.url, token, ...theme, label: "Again", about: "x" })).url.endsWith("/pull/2"), "existing fork reused");
      assert(fake.requests.filter(([, url]) => url.startsWith("/login/")).every(([, , auth]) => !auth), "no token sent to the login endpoints");
    } finally {
      await fake.close();
    }
  }

  // Update check (#37): version compare and installer pick.
  const { isNewer, pickDownload } = require("./lib/update");
  for (const [a, b] of [["0.4.0", "0.3.9"], ["v1.0.0", "0.10.0"], ["0.10.0", "0.9.0"], ["1.2.10", "1.2.9"]]) assert(isNewer(a, b), `${a} > ${b}`);
  for (const [a, b] of [["0.3.0", "0.3.0"], ["0.9.0", "0.10.0"], ["1.0", "0.1.0"], ["x.y.z", "0.1.0"], [undefined, "0.1.0"], ["2.0.0", "1.0.0.0"]]) assert(!isNewer(a, b), `${a} !> ${b}`);
  const gh = "https://github.com/PhaseN-Digital/phasen-sitebuilder-releases/releases/download/v1/";
  const downloads = { "win32-x64": gh + "a.exe", "darwin-arm64": gh + "b.dmg", "darwin-x64": "http://github.com/c.dmg", "linux-x64": "https://evil.example/github.com/d" };
  assert.strictEqual(pickDownload(downloads, "win32", "x64"), gh + "a.exe");
  assert.strictEqual(pickDownload(downloads, "win32", "arm64"), gh + "a.exe");
  assert.strictEqual(pickDownload(downloads, "darwin", "arm64"), gh + "b.dmg");
  assert.strictEqual(pickDownload(downloads, "darwin", "x64"), null, "http refused");
  assert.strictEqual(pickDownload(downloads, "linux", "x64"), null, "other hosts refused");
  // Linux x64 gets the AppImage (#153); there's no Linux arm64 build, so no fallback.
  const linux = { "linux-x64": gh + "PhaseN.Site.Builder-1.0.0-x86_64.AppImage", "win32-x64": gh + "a.exe" };
  assert.strictEqual(pickDownload(linux, "linux", "x64"), gh + "PhaseN.Site.Builder-1.0.0-x86_64.AppImage");
  assert.strictEqual(pickDownload(linux, "linux", "arm64"), null);
  assert.strictEqual(pickDownload({ "darwin-x64": "https://github.com.evil.example/x" }, "darwin", "x64"), null);
  assert.strictEqual(pickDownload(undefined, "darwin", "arm64"), null);

  // Settings resolver (#134): app default, site override (even blank), reset; old data migrates.
  {
    const cfg = require("./lib/settings");
    const appS = cfg.migrateSettings({ email: "app@example.com", defaults: { owner: "App Ltd", inboxDays: 30 }, cloudflare: { token: "T-app", accountId: "a1", accounts: [{ id: "a1" }] }, resendKey: "R-app" });
    assert.deepStrictEqual(appS.defaults, { owner: "App Ltd", inboxDays: 30, email: "app@example.com" });
    assert(!("email" in appS), "old top-level email moved to defaults");
    const s0 = { id: "x", name: "X", privacy: { owner: "Old Ltd", retention: "" }, analyticsId: "", inboxDays: 60, forms: [] };
    const migrated = cfg.migrateSite(structuredClone(s0));
    assert.deepStrictEqual(migrated.overrides, { owner: "Old Ltd", inboxDays: 60 }, "non-blank legacy values become overrides");
    assert(!("analyticsId" in migrated) && !("owner" in migrated.privacy) && cfg.migrateSite(migrated) === migrated);
    let r = cfg.resolve(appS, { ...migrated, overrides: {} });
    assert(r.email === "app@example.com" && r.owner === "App Ltd" && r.site.inboxDays === 30 && r.site.privacy.owner === "App Ltd" && r.cloudflare.token === "T-app" && r.resendKey === "R-app", "defaults");
    r = cfg.resolve(appS, { ...migrated, overrides: { owner: "Site Ltd", analyticsId: "" } }, { cloudflare: { token: "T-site", accountId: "s1", accounts: [{ id: "s1" }] } });
    assert(r.owner === "Site Ltd" && r.site.privacy.owner === "Site Ltd" && r.analyticsId === "" && r.email === "app@example.com" && r.cloudflare.token === "T-site" && r.resendKey === "R-app", "overrides");
    const reset = { ...migrated, overrides: { owner: "Site Ltd" } };
    delete reset.overrides.owner;
    assert.strictEqual(cfg.resolve(appS, reset).owner, "App Ltd", "reset falls back to the default");
    appS.defaults.owner = "Renamed Ltd";
    assert.strictEqual(cfg.resolve(appS, reset).owner, "Renamed Ltd", "default changes reach sites without an override");
    // Unpublish/inbox use the account that published, whichever is current now.
    const site = { cloudflare: { token: "T-site", accountId: "s1", accounts: [{ id: "s1" }] }, resendKey: "R-site" };
    const id = (v) => v;
    let p = cfg.publishedWith(appS, site, { accountId: "a1", resendKeyHash: cfg.keyHash("R-app") }, id);
    assert(p.cloudflare.token === "T-app" && p.cloudflare.accountId === "a1" && p.resendKey === "R-app", "published with the app's accounts");
    p = cfg.publishedWith(appS, site, { accountId: "s1", resendKeyHash: cfg.keyHash("R-site") }, id);
    assert(p.cloudflare.token === "T-site" && p.resendKey === "R-site", "published with the site's accounts");
    assert.strictEqual(cfg.publishedWith(appS, {}, { accountId: "gone" }, id).cloudflare, null, "that account isn't connected any more");
    assert.strictEqual(cfg.publishedWith(appS, site, {}, id).cloudflare.token, "T-site", "older publishes: the current account");
  }

  // JSON stores (#147): overlapping updates all survive, writes are atomic, a broken file recovers from its backup.
  {
    const cfg = require("./lib/settings");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-store-"));
    const st = cfg.store(root, { safe: { encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() }, portable: false, key: null });
    const file = path.join(root, "settings.json");
    await Promise.all(Array.from({ length: 50 }, (_, i) => st.update((s) => { s.defaults[`k${i}`] = i; })));
    const saved = JSON.parse(fs.readFileSync(file, "utf8")).defaults;
    assert.strictEqual(Object.keys(saved).length, 50, "all 50 concurrent updates survive");
    assert(Object.entries(saved).every(([k, v]) => k === `k${v}`));
    assert.deepStrictEqual(fs.readdirSync(root).sort(), ["settings.json", "settings.json.bak"], "no temp files left behind");
    // A crash mid-write elsewhere, or a hand edit: truncated JSON falls back to the last good backup.
    const errors = [];
    const realError = console.error;
    console.error = (m) => errors.push(m);
    try {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(0, 40));
      assert.strictEqual(Object.keys((await st.load()).defaults).length, 50, "truncated file read from the backup");
      await st.update((s) => { s.autoUpdate = false; });
      const fixed = JSON.parse(fs.readFileSync(file, "utf8"));
      assert(fixed.autoUpdate === false && Object.keys(fixed.defaults).length === 50, "an update after recovery keeps the backed-up values");
      fs.writeFileSync(file, "");
      fs.writeFileSync(`${file}.bak`, "{");
      assert.deepStrictEqual(await st.load(), { defaults: {} }, "both unreadable: defaults");
      fs.rmSync(file); fs.rmSync(`${file}.bak`);
    } finally {
      console.error = realError;
    }
    assert(errors.length === 3 && /using settings.json.bak/.test(errors[0]) && /using defaults/.test(errors[2]), "recoveries are logged");
    // A failing change saves nothing and doesn't block the queue.
    await assert.rejects(st.update(() => { throw new Error("nope"); }), /nope/);
    assert.strictEqual((await st.update((s) => { s.after = 1; })).after, 1);
    // Site accounts go through the same store.
    await Promise.all(["cloudflare", "resendKey"].map((k) => st.updateSite(root, (a) => { a[k] = k; })));
    assert.deepStrictEqual(await st.loadSite(root), { cloudflare: "cloudflare", resendKey: "resendKey" });
    assert(!fs.readFileSync(path.join(root, "accounts.json"), "utf8").includes("resendKey"), "the secret went to secrets.enc (#136)");
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Page layouts (#169): migration, every layout renders, blog order/pagination/sitemap, theme validation.
  {
    const { LAYOUTS, migrateLayouts } = require("./lib/layouts");
    const old = migrateLayouts({ pages: [{ id: "m", mirror: "/x/" }, { id: "a" }, { id: "b" }, { id: "c", layout: "legal" }, { id: "d", layout: "nope" }] });
    assert.deepStrictEqual(old.pages.map((p) => p.layout), [undefined, "home", "standard", "legal", "standard"], "first page home, the rest standard, copied pages none");
    const post = (n, date, extra = {}) => ({ id: `p${n}`, title: `Post ${n}`, layout: "blog-post", date, sections: [{ type: "richtext", html: `<p>Body of post ${n} &amp; more.</p>` }], ...extra });
    const lsite = { ...site, theme: "clean", forms: site.forms, pages: [
      ...LAYOUTS.filter((l) => l.id !== "blog-post").map((l) => ({ id: l.id.replace("-", ""), title: l.label, layout: l.id, sections: l.sections.map((x) => ({ ...x, formId: "contact" })) })),
      post(1, "2026-01-05", { author: "Jo <b>", excerpt: "Own excerpt", featuredImage: { src: "assets/abc123.webp", alt: "Bike" } }),
      ...Array.from({ length: 10 }, (_, i) => post(i + 2, `2025-0${(i % 9) + 1}-01`)), post(12, ""),
    ] };
    const lout = path.join(os.tmpdir(), "sitebuilder-test-layouts");
    const lp = await build(lsite, siteDir, lout, { hostname: "bikes.example" });
    const page = (href) => fs.readFileSync(path.join(lout, "public", href === "/" ? "index.html" : href.endsWith("/") ? `${href.slice(1)}index.html` : `${href.slice(1)}.html`), "utf8");
    for (const l of LAYOUTS) assert(page(lp[l.id === "blog-post" ? "p1" : l.id.replace("-", "")]).includes(`<body class="layout-${l.id}">`), `${l.id} renders`);
    const home = page("/");
    assert(home.includes("<h1>A big headline</h1>") && home.includes("<h2>Ready to talk?</h2>") && !home.includes("title-band"), "home: banner is the h1, a second banner an h2, no title band");
    assert(home.includes('<div class="cards"><div class="card"><h3>Service one</h3>'), "richtext cards");
    assert(!home.includes('href="/post-1"') && home.includes('href="/blog"'), "posts leave the menu when there's a blog page");
    assert(!page(lp.landing).includes('id="site-nav"') && !page(lp.landing).includes("nav-toggle"), "landing: no menu");
    assert(page(lp.standard).includes('<header class="title-band"><div class="wrap"><h1>Standard</h1></div></header>'), "standard: title band");
    assert(/<div class="contact-columns"><div><section class="form">[\s\S]*<\/div><div><section class="text">/.test(page(lp.contact)), "contact: form beside the details");
    const p1 = page(lp.p1);
    assert(p1.includes('<article class="post"><header class="title-band"><div class="wrap"><h1>Post 1</h1><p class="post-meta"><time datetime="2026-01-05">5 January 2026</time> · By Jo &lt;b&gt;</p>') && p1.includes('<meta property="og:type" content="article">'), "post meta");
    const blog = page(lp.blogindex);
    const order = [...blog.matchAll(/<h2><a href="\/post-(\d+)">/g)].map((m) => +m[1]);
    assert.deepStrictEqual(order, [1, 10, 9, 8, 7, 6, 5, 4, 3, 2], "newest first, ten per page");
    assert(blog.includes("<p>Own excerpt</p>") && blog.includes("<p>Body of post 10 &amp; more.</p>") && blog.includes('<a href="/blog/page/2/" rel="next">Older posts</a>'), "excerpts and pager");
    const blog2 = page("/blog/page/2/");
    assert.deepStrictEqual([...blog2.matchAll(/<h2><a href="\/post-(\d+)">/g)].map((m) => +m[1]), [11, 12], "page 2, same date keeps page order, undated last");
    assert(blog2.includes('<link rel="canonical" href="https://bikes.example/blog/page/2/">') && blog2.includes("<title>Blog | Bob&#39;s &lt;Bikes&gt; (page 2)</title>") && blog2.includes('rel="prev"'), "page 2 canonical/title");
    const sitemap = fs.readFileSync(path.join(lout, "public/sitemap.xml"), "utf8");
    assert(sitemap.includes("<loc>https://bikes.example/blog</loc>") && sitemap.includes("<loc>https://bikes.example/post-12</loc>") && sitemap.includes("<loc>https://bikes.example/blog/page/2/</loc>"), "blog in the sitemap");
    assert(page(lp.privacy).includes('<body class="layout-legal">'), "generated privacy page uses the legal layout");
    // Validator: layout-scoped CSS and per-layout notes; unknown layouts rejected. Its own list must match lib/layouts.js.
    assert.deepStrictEqual(require("./lib/theme-validate").LAYOUT_IDS, LAYOUTS.map((l) => l.id));
    const vdir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-layout-theme-"));
    const vt = (name, json, css) => { const d = path.join(vdir, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, "theme.json"), JSON.stringify({ label: "L", about: "A", font: "sans", colors: { background: "#ffffff", text: "#111111", primary: "#1d4ed8", accent: "#f59e0b" }, ...json })); fs.writeFileSync(path.join(d, "theme.css"), css); return validateTheme(d); };
    assert.deepStrictEqual(vt("ok", { layouts: { home: { notes: "Big banner" }, "blog-post": {} } }, ".layout-home .hero { padding: 0; }\n.layout-blog-post .title-band h1 { font-size: 2rem; }"), []);
    assert.deepStrictEqual(vt("bad", { layouts: { shop: {}, home: { notes: 1 } } }, ".layout-shop main { color: red; }"), [
      'theme.json: unknown layout "shop" (one of home, standard, landing, services, contact, blog-post, blog-index, legal)',
      'theme.json: layouts.home may only have "notes", a string up to 500 characters',
      "theme.css: unknown layout class .layout-shop"]);
  }

  // HTML templates (#200): the validator rejects each forbidden construct, placeholders are escaped,
  // a theme's templates reach the build, and an invalid one falls back to the built-in templates.
  {
    const { validateTemplate } = require("./lib/theme-validate");
    const tpl = require("./lib/templates");
    const tb = require("./lib/theme-builder");
    for (const [name, html] of Object.entries(tpl.DEFAULTS)) assert.deepStrictEqual(validateTemplate(name.startsWith("layout-") ? "layout" : name, html), [], `default ${name} is valid`);
    const ok = '<header class="site-header"><div class="wrap"><a class="brand" href="/">{{brand}}</a>{{#if site.logo}}<img src="{{site.logo}}" alt="{{site.name}}">{{/if}}{{menu}}</div></header>';
    assert.deepStrictEqual(validateTemplate("header", ok), []);
    assert.deepStrictEqual(validateTemplate("layout", '<div class="cols"><aside>Hi</aside>{{content}}<a href="https://example.com/x?a=1&amp;b=2">x</a><img src="https://images.unsplash.com/p.jpg" alt=""><iframe src="https://www.youtube-nocookie.com/embed/abcdefghijk"></iframe></div>'), []);
    const rejects = (kind, html, re) => assert.match(validateTemplate(kind, html).join("\n"), re, html);
    const H = (x) => `{{menu}}${x}`;
    rejects("header", H("<script>alert(1)</script>"), /<script> is not allowed/);
    rejects("header", H("<SCRIPT src=x></SCRIPT>"), /<script> is not allowed/);
    rejects("header", H("<style>a{background:url(javascript:x)}</style>"), /<style> is not allowed/);
    rejects("header", H('<div style="background:url(javascript:x)">'), /style=: no url\(\)/);
    rejects("header", H('<img src="/a.png" onerror="x()">'), /event-handler attributes \(onerror=\)/);
    rejects("header", H('<a href="#" OnClick="x()">'), /event-handler attributes \(onclick=\)/);
    rejects("header", H('<a href="javascript:alert(1)">x</a>'), /javascript: URLs are not allowed/);
    rejects("header", H('<a href=" JaVa\tScRiPt:alert(1)">x</a>'), /javascript: URLs are not allowed/);
    rejects("header", H('<a href="jav&#x61;script:alert(1)">x</a>'), /character references/);
    rejects("header", H('<img src="data:image/svg+xml,<svg>">'), /data: URLs are not allowed/);
    rejects("header", H('<img src="https://evil.example/t.gif">'), /external images must be https from images\.unsplash\.com/);
    rejects("header", H('<img src="//evil.example/t.gif">'), /external images/);
    rejects("header", H('<img srcset="/a.png 1x, http://images.unsplash.com/b.png 2x">'), /external images/);
    rejects("header", H('<iframe src="https://evil.example/embed"></iframe>'), /<iframe> may only embed YouTube/);
    rejects("header", H('<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>'), /<iframe> may only embed YouTube/);
    rejects("header", H('<iframe srcdoc="<script>x</script>"></iframe>'), /attribute srcdoc= is not allowed/);
    for (const t of ["object", "embed"]) rejects("header", H(`<${t} data="x.swf"></${t}>`), new RegExp(`<${t}> is not allowed`));
    for (const t of ["form", "input", "button", "textarea", "select"]) rejects("header", H(`<${t}>`), /forms are not allowed/);
    rejects("header", H('<link rel="stylesheet" href="https://fonts.example/x.css">'), /<link> is not allowed/);
    rejects("header", H('<base href="https://evil.example/">'), /<base> is not allowed/);
    rejects("header", H("<svg><script>x</script></svg>"), /<svg> is not allowed/);
    rejects("header", H("<!-- x --><b>x</b>"), /comments/);
    rejects("header", H('<?x <a title="> <img src=x onerror=alert(1)> ">'), /<\?…>/);
    rejects("header", H("</ x>"), /comments/);
    rejects("header", H("<b <script>"), /<script/);
    rejects("header", H('<a href="{{site.name}}">x</a>'), /href= may only be a whole URL placeholder/);
    rejects("header", H("<a class={{site.name}}>x</a>"), /put placeholders in quotes/);
    rejects("header", H('<a title="{{menu}}">x</a>'), /\{\{menu\}\} can't be used inside a tag/);
    rejects("header", H("{{nope}} {{ site.name }} {{{brand}}}"), /unknown placeholder \{\{nope\}\}[\s\S]*malformed placeholder/);
    rejects("header", H("{{#if site.name}}x"), /without \{\{\/if\}\}/);
    rejects("header", "<header>{{brand}}</header>", /must include \{\{menu\}\}/);
    rejects("layout", "<div></div>", /must include \{\{content\}\}/);
    rejects("footer", "<footer>{{year}}</footer>", /must include \{\{footer\.links\}\}/);

    // Rendering: escaped by default, html placeholders as given, {{#if}} (nested) on non-empty values only.
    assert.strictEqual(tpl.render("<b>{{site.name}}</b>{{content}}", { "site.name": `<i>"Bob's"</i>`, content: { html: "<p>ok</p>" } }), "<b>&lt;i&gt;&quot;Bob&#39;s&quot;&lt;/i&gt;</b><p>ok</p>");
    assert.strictEqual(tpl.render('{{#if a}}A{{#if b}}B{{/if}}{{/if}}{{#if c}}C{{/if}}', { a: "1", b: { html: "" }, c: "" }), "A");
    assert.strictEqual(tpl.render("{{x}}", { x: "{{y}}", y: "no" }), "{{y}}", "values aren't rendered again");

    // A theme with a header template builds with it; an invalid one falls back with a clear message.
    const sample = tb.sampleSite({}, "tpl");
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-tpl-site-"));
    const header = '<header class="site-header custom-head"><div class="wrap"><a class="brand" href="/">{{brand}}</a><span class="tagline">{{page.title}} at {{site.name}}</span>{{menu}}</div></header>';
    const layout = '<div class="layout-box">{{content}}</div>';
    assert.deepStrictEqual(await tb.writeTheme(path.join(sdir, "theme"), { templates: { header, "layout-contact": layout, section: '<div class="sec sec-{{section.type}}">{{content}}</div>' } }), []);
    const back = await tb.listLocal(sdir);
    assert(back.theme.templates && back.theme.controls.templates.header === header, "templates read back as controls");
    const tout = fs.mkdtempSync(path.join(os.tmpdir(), "sb-tpl-built-"));
    const warn = console.warn; const warned = []; console.warn = (m) => warned.push(m);
    try {
      await build({ ...sample, name: "Bob's <Shop>" }, sdir, tout);
      const home = fs.readFileSync(path.join(tout, "public/index.html"), "utf8");
      assert(home.includes('<span class="tagline">Home at Bob&#39;s &lt;Shop&gt;</span><button type="button" class="nav-toggle"'), "header template rendered, escaped");
      assert(home.includes('<div class="sec sec-hero"><section class="hero">') && !home.includes("layout-box"), "section wrapper on every section, layout template only on its layout");
      assert(fs.readFileSync(path.join(tout, "public/contact.html"), "utf8").includes('<main><div class="layout-box">'), "layout template wraps the contact page's main");
      assert.deepStrictEqual(warned, []);
      fs.writeFileSync(path.join(sdir, "theme", "footer.html"), '<footer onclick="x()">{{footer.links}}</footer>');
      await build(sample, sdir, tout);
      const fallback = fs.readFileSync(path.join(tout, "public/index.html"), "utf8");
      assert(!fallback.includes("custom-head") && !fallback.includes("onclick=\"x()\"") && fallback.includes('<header class="site-header"><div class="wrap"><a class="brand" href="/">'), "invalid templates fall back to the built-in ones");
      assert.match(warned.join(), /HTML templates can't be used, so the built-in ones were used instead: footer\.html: event-handler attributes/);
    } finally { console.warn = warn; }
    assert.match(validateTheme(path.join(sdir, "theme")).join(), /footer\.html: event-handler/, "and the package is invalid");
    assert.match((await tb.writeTheme(path.join(sdir, "t2"), { templates: { header: "<script></script>" } })).join(), /header\.html: <script> is not allowed/, "the builder can't save a bad template");
    assert.deepStrictEqual(tb.clean({ templates: { header: tpl.DEFAULTS.header, evil: "x", footer: 1 } }).templates, {}, "only changed, known templates are kept");
  }

  // Secrets at rest (#136): split out of the JSON files into secrets.enc, OS keystore or portable passphrase.
  {
    const sec = require("./lib/secrets");
    const cfg = require("./lib/settings");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sb-secrets-"));
    // A stand-in for safeStorage: reversible, but not plain text. `machine` decides which "computer" can read it.
    const fakeSafe = (machine) => ({
      encrypt: (t) => Buffer.from(`${machine}:${Buffer.from(t).toString("hex")}`),
      decrypt: (b) => { const [m, hex] = b.toString().split(":"); if (m !== machine) throw new Error("other machine"); return Buffer.from(hex, "hex").toString(); },
    });
    const { plain, secrets: found } = sec.split({ cloudflare: { token: "T", accountId: "a" }, themeSources: [{ spec: "x/y", token: "G" }], turnstile: { sitekey: "k", secret: "S" }, sendingKey: "R", d1: { id: "db" } });
    assert.deepStrictEqual(plain, { cloudflare: { accountId: "a" }, themeSources: [{ spec: "x/y" }], turnstile: { sitekey: "k" }, d1: { id: "db" } });
    assert.strictEqual(sec.join(plain, found).themeSources[0].token, "G");
    assert.deepStrictEqual(sec.join({}, found), { sendingKey: "R" }, "a secret whose parent has gone is dropped");

    const keyring = { safe: fakeSafe("A"), portable: false, key: null };
    const site = path.join(root, "site");
    fs.mkdirSync(site);
    const st = cfg.store(path.join(root, ".phasen"), keyring);
    fs.mkdirSync(path.join(root, ".phasen"));
    await st.update((s) => { s.cloudflare = { token: "cf-secret-1", accountId: "a1" }; s.resendKey = "re-secret-1"; });
    await st.updateSite(site, (a) => { a.resendKey = "re-site-secret"; });
    await st.updateState(site, (p) => { p.turnstile = { sitekey: "k", secret: "ts-secret" }; p.url = "https://x"; });
    const onDisk = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    assert(!/cf-secret-1|re-secret-1|re-site-secret|ts-secret/.test(onDisk(root)), "no secret in plain text anywhere on disk");
    assert(fs.existsSync(path.join(site, ".secrets", "secrets.enc")) && !fs.readFileSync(path.join(site, "publish.json"), "utf8").includes("secret"));
    assert.strictEqual((await st.load()).cloudflare.token, "cf-secret-1");
    assert.strictEqual((await st.loadState(site)).turnstile.secret, "ts-secret");
    assert.strictEqual((await st.loadSite(site)).resendKey, "re-site-secret");
    const mtime = fs.statSync(path.join(root, ".phasen", "secrets.enc")).mtimeMs;
    await st.update((s) => { s.defaults.email = "x@example.com"; });
    assert.strictEqual(fs.statSync(path.join(root, ".phasen", "secrets.enc")).mtimeMs, mtime, "secrets.enc only rewritten when a secret changes");

    // Another machine (or a damaged file): no crash, secrets just missing, a clear "re-enter" message.
    const other = cfg.store(path.join(root, ".phasen"), { safe: fakeSafe("B"), portable: false, key: null });
    const app2 = await other.load();
    assert(app2.cloudflare.accountId === "a1" && !app2.cloudflare.token && !app2.resendKey && app2.defaults.email === "x@example.com");
    assert.strictEqual(cfg.resolve(app2, { overrides: {} }).cloudflare, null, "a Cloudflare account without its token counts as not connected");
    assert(sec.problems().some((m) => /Re-enter your Cloudflare token/.test(m)), sec.problems());
    fs.writeFileSync(path.join(site, ".secrets", "secrets.enc"), "{ not json");
    fs.writeFileSync(path.join(site, ".secrets", "secrets.enc.bak"), "{ not json");
    const quiet = console.error; console.error = () => {};
    try {
      assert.strictEqual((await st.loadState(site)).turnstile.secret, undefined, "corrupt secrets file: values missing, no throw");
      assert(sec.problems().some((m) => /Re-enter/.test(m)), "and the re-enter message");
      await st.updateState(site, (p) => { p.turnstile.secret = "ts-2"; });
      assert(fs.readdirSync(path.join(site, ".secrets")).some((f) => f.startsWith("secrets.enc.unreadable-")), "corrupt file kept aside");
      assert.strictEqual((await st.loadState(site)).turnstile.secret, "ts-2");
    } finally { console.error = quiet; }
    // Re-entering a secret on the other machine keeps the unreadable file aside rather than losing it.
    await other.update((s) => { s.resendKey = "re-new"; });
    assert(fs.readdirSync(path.join(root, ".phasen")).some((f) => f.startsWith("secrets.enc.unreadable-")) && (await other.load()).resendKey === "re-new");

    // Portable: passphrase -> scrypt -> AES-256-GCM; readable anywhere with the passphrase, never stored.
    const { key, config: pcfg } = await sec.makePortable("correct horse battery");
    assert(!JSON.stringify(pcfg).includes("correct horse"));
    const portable = { safe: fakeSafe("A"), portable: true, key };
    const appSecrets = path.join(root, ".phasen", "secrets.enc"), written = fs.readFileSync(appSecrets, "utf8");
    assert.deepStrictEqual(await sec.reencrypt([appSecrets, path.join(site, ".secrets", "secrets.enc")], keyring, portable), [appSecrets], "a file this keyring can't read is skipped");
    assert.strictEqual(fs.readFileSync(appSecrets, "utf8"), written, "and left as it was");
    const pst = cfg.store(path.join(root, ".phasen"), portable);
    await pst.updateSite(site, (a) => { a.cloudflare = { token: "cf-portable", accountId: "p" }; });
    const env = JSON.parse(fs.readFileSync(path.join(site, ".secrets", "secrets.enc"), "utf8"));
    assert(env.mode === "portable" && env.iv && env.tag && !JSON.stringify(env).includes("cf-portable"));
    const newMachine = { safe: fakeSafe("C"), portable: true, key: null };
    assert(!(await cfg.store(path.join(root, ".phasen"), newMachine).loadSite(site)).cloudflare.token, "locked until the passphrase is entered");
    assert(sec.problems().some((m) => /Enter it in Settings › Data/.test(m)));
    await assert.rejects(cfg.store(path.join(root, ".phasen"), newMachine).updateSite(site, (a) => { a.resendKey = "x"; }), /passphrase/, "no write while locked");
    await assert.rejects(sec.unlock(pcfg, "wrong passphrase"), /isn't the one/);
    newMachine.key = await sec.unlock(pcfg, "correct horse battery");
    assert.strictEqual((await cfg.store(path.join(root, ".phasen"), newMachine).loadSite(site)).cloudflare.token, "cf-portable", "unlocked on a new machine");
    // Tampering is detected (GCM), not silently accepted.
    env.data = Buffer.from("x" + Buffer.from(env.data, "base64").toString("latin1").slice(1), "latin1").toString("base64");
    assert.throws(() => sec.decrypt(env, portable), /couldn't be unlocked/);
    fs.rmSync(root, { recursive: true, force: true });
  }

  // Site history (#136): one repo per site, readable batched commits, tags, page-level changes, revert as a new commit.
  {
    const repo = require("./lib/site-repo");
    const cfg = require("./lib/settings");
    const git = require("isomorphic-git");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-repo-"));
    const who = { name: "Tester", email: "t@example.com" };
    const w = (f, v) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof v === "string" ? v : JSON.stringify(v)); };
    const s1 = { id: "s", name: "Shop", theme: "clean", pages: [{ id: "h", title: "Home", sections: [{ text: "hi" }] }, { id: "m", title: "About", mirror: "/about/", file: "about/index.html", sections: [] }], forms: [] };
    w("site.json", s1);
    w("mirror/about/index.html", "<h1>About</h1>");
    const st = cfg.store(dir, { safe: { encrypt: (t) => Buffer.from(t).reverse(), decrypt: (b) => Buffer.from(b).reverse().toString() }, portable: false, key: null });
    await st.updateState(dir, (p) => { p.turnstile = { sitekey: "k", secret: "TS-SECRET-VALUE" }; p.sendingKey = "RE-SECRET-VALUE"; });
    assert.strictEqual(await repo.ensure(dir, who), true);
    assert.strictEqual(await repo.ensure(dir, who), false, "ensure is idempotent");
    assert.strictEqual(await repo.commit(dir, null, who), null, "nothing changed, no commit");
    w("site.json", { ...s1, pages: [{ ...s1.pages[0], sections: [{ text: "hello" }] }, s1.pages[1], { id: "c", title: "Contact", sections: [] }] });
    w("mirror/about/index.html", "<h1>About us</h1>");
    w("assets/a.webp", "img");
    await repo.commit(dir, null, who);
    let log = await repo.log(dir);
    assert.strictEqual(log[0].message, "Edited page Home; Added page Contact; Edited copied page About and 1 more", log[0].message);
    assert.deepStrictEqual(await repo.changes(dir, log[0].oid), ["Edited page Home", "Added page Contact", "Edited copied page About", "Changed images"]);
    assert.deepStrictEqual(await repo.changes(dir, log.at(-1).oid), ["Created the website"]);
    const v2 = log[0].oid;
    assert.strictEqual(await repo.tag(dir, "live-20260101-1200"), "live-20260101-1200");
    assert.strictEqual(await repo.tag(dir, "live-20260101-1200"), "live-20260101-1200-2", "same-minute publishes get distinct tags");
    assert.deepStrictEqual((await repo.log(dir))[0].tags.sort(), ["live-20260101-1200", "live-20260101-1200-2"]);

    // Secrets are never staged, even with .gitignore emptied and a stray secrets.enc elsewhere.
    w(".gitignore", "");
    w("secrets.enc", "x");
    w(".secrets/extra.txt", "x");
    w("site.json", { ...s1, name: "Shop 2" });
    await st.updateState(dir, (p) => { p.url = "https://shop.example"; p.turnstile.secret = "TS-SECRET-2"; });
    await repo.commit(dir, null, who);
    const tracked = await git.listFiles({ fs, dir });
    assert(!tracked.some(repo.forbidden) && tracked.includes("publish.json"), tracked);
    // No secret value in any blob of any commit.
    for (const { oid } of await repo.log(dir)) {
      for (const f of await git.listFiles({ fs, dir, ref: oid })) {
        const { blob } = await git.readBlob({ fs, dir, oid, filepath: f });
        assert(!/TS-SECRET|RE-SECRET/.test(Buffer.from(blob).toString()), `${f} in ${oid} holds a secret`);
      }
    }

    // Revert to v2: content back, publish.json (what's live) left alone, a new commit on top.
    const before = (await repo.log(dir)).length;
    await repo.revert(dir, v2, who);
    log = await repo.log(dir);
    assert(log.length === before + 1 && /^Restored the version from/.test(log[0].message));
    const back = JSON.parse(fs.readFileSync(path.join(dir, "site.json"), "utf8"));
    assert(back.name === "Shop" && back.pages.length === 3 && fs.readFileSync(path.join(dir, "mirror/about/index.html"), "utf8") === "<h1>About us</h1>");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "publish.json"), "utf8")).url, "https://shop.example", "revert keeps publish state");
    assert.strictEqual((await st.loadState(dir)).turnstile.secret, "TS-SECRET-2", "revert keeps secrets");
    assert.deepStrictEqual(await repo.largeFiles(dir), []);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // GitHub sync (#137): push, pull, restore elsewhere, conflicts kept as branches, settings, against real git smart HTTP.
  {
    const sync = require("./lib/sync");
    const repo = require("./lib/site-repo");
    const folder = require("./lib/sites-folder");
    const git = require("isomorphic-git");
    const host = await require("./test/fakes").startGitHost();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-sync-"));
    try {
      const who = { name: "Tester", email: "t@example.com" };
      const o = { login: host.url, token: host.token, author: who };
      const A = path.join(base, "a", "shop"), rootB = path.join(base, "b");
      fs.mkdirSync(A, { recursive: true }); fs.mkdirSync(rootB);
      const id = "33333333-3333-4333-8333-333333333333";
      const w = (dir, f, v) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof v === "string" ? v : JSON.stringify(v)); };
      const site = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "site.json"), "utf8"));
      w(A, "site.json", { id, name: "Shop", pages: [] });
      w(A, ".secrets/secrets.enc", "SECRET-BLOB");
      await repo.ensure(A, who);

      assert.strictEqual(sync.parseSpec("https://github.com/octo/site-shop.git"), "octo/site-shop");
      assert.throws(() => sync.parseSpec("octo/../x"), /isn't a GitHub repository/);
      assert.throws(() => sync.parseSpec("octo"), /isn't a GitHub repository/);
      const spec = await sync.createRepo({ api: host.url, token: host.token, user: "octo", owner: "octo", name: "site-shop" });
      assert.strictEqual(spec, "octo/site-shop");
      assert.strictEqual(await sync.createRepo({ api: host.url, token: host.token, user: "octo", owner: "PhaseN-Digital", name: "site-shop" }), "PhaseN-Digital/site-shop", "org repos via /orgs");
      await assert.rejects(sync.createRepo({ api: host.url, token: host.token, user: "octo", owner: "octo", name: "site-shop" }), /already exists/);
      await assert.rejects(sync.sync(A, o), /isn't connected/);
      await sync.connect(A, host.url, spec);
      assert.strictEqual(await sync.remote(A, host.url), spec);
      assert.strictEqual(await sync.remote(A, "https://elsewhere.example"), null, "a remote on another host isn't trusted with the token");
      await assert.rejects(sync.sync(A, { ...o, token: "wrong" }), /didn't accept your sign-in/);
      assert.deepStrictEqual(await sync.sync(A, o), { status: "pushed" });
      assert.deepStrictEqual(await sync.sync(A, o), { status: "up to date" });
      assert(!/secrets/.test(host.git(spec, "ls-tree", "-r", "--name-only", "main")), "secrets never pushed");

      // Restore on another computer.
      const has = () => false;
      await assert.rejects(sync.clone({ root: rootB, ...o, spec, freeDir: folder.freeDir, has: () => true }), /already in your sites folder/);
      await assert.rejects(sync.clone({ root: rootB, ...o, spec: "PhaseN-Digital/site-shop", freeDir: folder.freeDir, has }), /doesn't hold a PhaseN Site Builder website/);
      const { id: got, dir: B } = await sync.clone({ root: rootB, ...o, spec, freeDir: folder.freeDir, has });
      assert(got === id && B === path.join(rootB, "shop") && site(B).name === "Shop");
      assert.deepStrictEqual([...(await folder.scan(rootB)).keys()], [id], "a restored site is found by the scan; no clone leftovers");
      assert.strictEqual(await sync.remote(B, host.url), spec);

      // B changes, A pulls (an added and a removed file both arrive).
      w(B, "site.json", { id, name: "Shop B", pages: [] });
      w(B, "assets/x.webp", "img");
      assert.deepStrictEqual(await sync.sync(B, o), { status: "pushed" });
      w(A, "notes-from-a.txt", "x"); await repo.commit(A, null, who);
      fs.rmSync(path.join(B, "assets/x.webp"));
      // Both changed: nothing overwritten, GitHub's version kept as a branch here.
      w(A, "site.json", { id, name: "Shop A", pages: [] });
      const c = await sync.sync(A, o);
      assert(c.status === "conflict" && /^github-\d{8}-\d{4}$/.test(c.branch), c);
      assert.strictEqual(site(A).name, "Shop A", "local edits untouched");
      assert.strictEqual(host.git(spec, "show", "main:site.json").includes("Shop B"), true, "GitHub's untouched");
      assert(fs.existsSync(path.join(A, ".secrets/secrets.enc")));
      await assert.rejects(sync.resolve(A, { ...o, branch: c.branch, keep: "both" }), /Bad choice/);
      assert.deepStrictEqual(await sync.resolve(A, { ...o, branch: c.branch, keep: "theirs" }), { status: "pulled" });
      assert(site(A).name === "Shop B" && fs.existsSync(path.join(A, "assets/x.webp")) && !fs.existsSync(path.join(A, "notes-from-a.txt")));
      assert(fs.existsSync(path.join(A, ".secrets/secrets.enc")), "untracked secrets survive a checkout");
      const log = await repo.log(A);
      assert(log.some((v) => /Changed website settings/.test(v.message)) && log[0].message === "Took GitHub's version over this computer's", "A's own versions stay in history");
      assert.deepStrictEqual(await git.listBranches({ fs, dir: A }), ["main"]);
      assert.strictEqual(host.git(spec, "rev-parse", "main").trim(), log[0].oid, "the merge is on GitHub");
      // B's uncommitted removal is committed before syncing, so B has diverged too.
      const c2 = await sync.sync(B, o);
      assert.strictEqual(c2.status, "conflict");
      assert.deepStrictEqual(await sync.resolve(B, { ...o, branch: c2.branch, keep: "mine" }), { status: "pushed" });
      assert(!fs.existsSync(path.join(B, "assets/x.webp")));
      assert.deepStrictEqual(await sync.sync(A, o), { status: "pulled" });
      assert(!fs.existsSync(path.join(A, "assets/x.webp")) && site(A).name === "Shop B");

      // Shared settings: an allowlist, so no secret can ever reach GitHub.
      const settingsSpec = await sync.createRepo({ api: host.url, token: host.token, user: "octo", owner: "octo", name: "sitebuilder-settings" });
      const s1 = { defaults: { email: "me@example.com", owner: "Me Ltd", junk: "x" }, resendKey: "re_SECRET", github: { token: "TOKEN-SECRET" }, cloudflare: { token: "CF-SECRET" }, themeSources: [{ spec: "acme/themes", token: "SRC-SECRET" }] };
      const d1 = path.join(base, "settings-a"), d2 = path.join(base, "settings-b");
      const first = await sync.syncSettings(d1, { ...o, spec: settingsSpec }, s1);
      assert.deepStrictEqual(first, { status: "pushed", shared: null });
      const pushed = host.git(settingsSpec, "show", "main:shared.json");
      assert(!/SECRET|junk/.test(pushed), pushed);
      const s2 = { defaults: { email: "old@example.com", inboxDays: 30 }, themeSources: [{ spec: "mine/themes", token: "KEEP" }] };
      const pulled = await sync.syncSettings(d2, { ...o, spec: settingsSpec }, s2);
      assert.strictEqual(pulled.status, "pulled");
      sync.applyShared(s2, pulled.shared);
      assert.deepStrictEqual(s2, { defaults: { email: "me@example.com", owner: "Me Ltd", inboxDays: 30 }, hidePublicThemes: false, themeSources: [{ spec: "mine/themes", token: "KEEP" }, { spec: "acme/themes" }] });
      assert.deepStrictEqual((await sync.syncSettings(d2, { ...o, spec: settingsSpec }, s2)).status, "pushed");
      const back = await sync.syncSettings(d1, { ...o, spec: settingsSpec }, s1);
      assert(back.status === "pulled" && back.shared.defaults.inboxDays === 30, "unchanged here: GitHub's come in");
      s1.defaults.email = "a@example.com"; s2.defaults.email = "b@example.com";
      await sync.syncSettings(d2, { ...o, spec: settingsSpec }, s2);
      assert.strictEqual((await sync.syncSettings(d1, { ...o, spec: settingsSpec }, s1)).status, "conflict", "both changed: asked, not overwritten");
    } finally {
      await host.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  }

  // Sites folder (#136): migration from userData/sites is copy, verify, then remove; idempotent and safe to interrupt.
  {
    const folder = require("./lib/sites-folder");
    const cfg = require("./lib/settings");
    const repo = require("./lib/site-repo");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sb-migrate-"));
    const legacyRoot = path.join(base, "userData", "sites"), root = path.join(base, "PhaseN Sites");
    const legacySeal = (v) => Buffer.from(`sealed:${v}`).toString("base64");
    const unsealLegacy = (v) => { const t = Buffer.from(v, "base64").toString(); return t.startsWith("sealed:") ? t.slice(7) : null; };
    const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const makeLegacy = (id, name) => {
      const d = path.join(legacyRoot, id);
      fs.mkdirSync(path.join(d, "assets"), { recursive: true });
      fs.writeFileSync(path.join(d, "site.json"), JSON.stringify({ id, name, pages: [], forms: [] }));
      fs.writeFileSync(path.join(d, "assets", "x.webp"), "img");
      fs.writeFileSync(path.join(d, "publish.json"), JSON.stringify({ url: "https://x", turnstile: { sitekey: "k", secret: legacySeal("TS-LEGACY") }, sendingKey: "not-decryptable" }));
      fs.writeFileSync(path.join(d, "publish.json.bak"), "{}");
    };
    makeLegacy(ids[0], "Bob's Bikes");
    makeLegacy(ids[1], "Bob's Bikes");
    fs.mkdirSync(path.join(root, ".phasen"), { recursive: true });
    const store = cfg.store(path.join(root, ".phasen"), { safe: { encrypt: (t) => Buffer.from(t).reverse(), decrypt: (b) => Buffer.from(b).reverse().toString() }, portable: false, key: null });
    const opts = { legacyRoot, root, store, unsealLegacy, author: { name: "T", email: "t@example.com" } };

    // Interrupted twice: once mid-copy (a partial temp copy), once after the rename but before removing the original.
    fs.mkdirSync(path.join(root, `.moving-${ids[0]}`));
    fs.writeFileSync(path.join(root, `.moving-${ids[0]}`, "partial"), "x");
    const cp = fs.promises.rm;
    let failOnce = true;
    fs.promises.rm = async (p, o) => { if (failOnce && p === path.join(legacyRoot, ids[1])) { failOnce = false; throw new Error("power cut"); } return cp(p, o); };
    await assert.rejects(folder.migrateLegacy(opts), /power cut/);
    fs.promises.rm = cp;
    assert(fs.existsSync(path.join(legacyRoot, ids[1])), "original kept until the copy is in place");
    assert.strictEqual(await folder.migrateLegacy(opts), 1, "the rerun finishes the job");
    assert.strictEqual(await folder.migrateLegacy(opts), 0, "and then there's nothing to do");
    const found = await folder.scan(root);
    assert.deepStrictEqual([...found.keys()].sort(), ids, "each site once, no duplicate from the interrupted run");
    assert.deepStrictEqual(fs.readdirSync(root).sort(), [".phasen", "bob-s-bikes", "bob-s-bikes-2"]);
    assert(!fs.existsSync(legacyRoot) || !fs.readdirSync(legacyRoot).length);
    for (const dir of found.values()) {
      assert(await repo.isRepo(dir) && fs.readFileSync(path.join(dir, "assets", "x.webp"), "utf8") === "img");
      const p = await store.loadState(dir);
      assert(p.turnstile.secret === "TS-LEGACY" && p.url === "https://x" && !("sendingKey" in p), "legacy secrets re-encrypted, undecryptable ones dropped");
      assert(!fs.readFileSync(path.join(dir, "publish.json"), "utf8").includes(legacySeal("TS-LEGACY")) && !fs.existsSync(path.join(dir, "publish.json.bak")) || !fs.readFileSync(path.join(dir, "publish.json.bak"), "utf8").includes("sealed"));
      assert.strictEqual((await repo.log(dir))[0].message, "Moved into the PhaseN Sites folder");
    }
    // Legacy settings.json the same way.
    const legacyFile = path.join(base, "userData", "settings.json");
    fs.writeFileSync(legacyFile, JSON.stringify({ defaults: { email: "a@example.com" }, resendKey: legacySeal("RE-LEGACY") }));
    assert.strictEqual(await folder.migrateLegacySettings({ legacyFile, store, newFile: path.join(root, ".phasen", "settings.json"), unsealLegacy }), true);
    assert((await store.load()).resendKey === "RE-LEGACY" && !fs.existsSync(legacyFile) && !fs.readFileSync(path.join(root, ".phasen", "settings.json"), "utf8").includes("resendKey"));
    assert.strictEqual(await folder.migrateLegacySettings({ legacyFile, store, newFile: path.join(root, ".phasen", "settings.json"), unsealLegacy }), false);

    // Changing the folder: everything moves, the switch is recorded before the originals go.
    const to = path.join(base, "Elsewhere");
    let switched = false;
    assert.strictEqual(await folder.moveAll(root, to, async () => { switched = true; assert.strictEqual((await folder.scan(root)).size, 2, "originals still there at the switch"); }), 2);
    assert(switched && (await folder.scan(to)).size === 2 && (await folder.scan(root)).size === 0 && fs.existsSync(path.join(to, ".phasen", "secrets.enc")));

    // Renaming a site renames its folder (#177): a no-op when it already matches, a suffix on a clash, the repo intact.
    const bikes = path.join(to, "bob-s-bikes"), bikes2 = path.join(to, "bob-s-bikes-2");
    assert.strictEqual(await folder.renameToMatch(bikes, "Bob's Bikes!"), bikes);
    assert.strictEqual(await folder.renameToMatch(bikes2, "Bob's bikes"), bikes2, "a numbered folder still matches");
    fs.mkdirSync(path.join(to, "cycles"));
    const cycles = await folder.renameToMatch(bikes2, "Cycles");
    assert.strictEqual(cycles, path.join(to, "cycles-2"));
    const moved = await folder.scan(to);
    assert(moved.size === 2 && [...moved.values()].includes(cycles) && (await repo.log(cycles))[0].message === "Moved into the PhaseN Sites folder");
    // Interrupted: a rename that fails (a file open on Windows, a power cut) leaves the folder whole under its old name.
    const rename = fs.promises.rename;
    fs.promises.rename = async () => { throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" }); };
    await assert.rejects(folder.renameToMatch(cycles, "Wheels"), /EBUSY/);
    fs.promises.rename = rename;
    assert.deepStrictEqual(await folder.scan(to), moved, "nothing moved, nothing lost");
    // Killed after the rename but before the app recorded it: the next scan finds the site at its new name, once.
    const wheels = await folder.renameToMatch(cycles, "Wheels");
    const rescanned = await folder.scan(to);
    assert(rescanned.size === 2 && [...rescanned.values()].includes(wheels) && !fs.existsSync(cycles) && await repo.isRepo(wheels));
    fs.rmSync(base, { recursive: true, force: true });
  }

  const { execFileSync } = require("node:child_process");
  for (const dir of [".", "app", "lib", "runtime", "scripts", "test"]) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) execFileSync(process.execPath, ["--check", path.join(dir, f)]);
  }
  const titleOk = (t) => { try { execFileSync(process.execPath, ["scripts/check-commit.js", "--message", t], { stdio: "ignore" }); return true; } catch { return false; } };
  for (const t of ["feat: x", "fix(publish): y", "ci!: z"]) assert(titleOk(t), t);
  for (const t of ["Add thing", "Merge branch x", 'Revert "feat: x"', "", "feat:x"]) assert(!titleOk(t), t);

  console.log("ok:", out);
})();
