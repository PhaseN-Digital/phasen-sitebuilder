// Self-check for the site builder: `npm test`. Builds a sample site and
// asserts on the output.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build, pruneAssets } = require("./lib/build");

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
          assert.strictEqual(wp.requests.some(([, authed]) => authed), hidden, `hidden=${hidden}: credentials ${hidden ? "used" : "unused"}`);
        } finally { await wp.close(); }
      }
      const wp = await startWordPress({ hidden: true });
      await assert.rejects(fetchWordPress(wp.url, "", ""), /needs a username/);
      await wp.close();
    } finally { globalThis.fetch = realFetch; }
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
  const runRedirect = async (zone) => {
    const calls = [], logs = [];
    globalThis.fetch = async (url, { method, body }) => {
      calls.push({ method, url: url.replace("https://api.cloudflare.com/client/v4", ""), body: body && JSON.parse(body) });
      const result = method !== "GET" ? {} : url.includes("dns_records") ? zone.records : zone.rules && { rules: zone.rules };
      return { status: 200, json: async () => (result ? { success: true, result } : { success: false, errors: [{ message: "not found" }] }) };
    };
    await ensureWwwRedirect("t", { id: "z1", name: "bob.com" }, (l) => logs.push(l));
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
    await assert.rejects(ts.fetchSource(fakeGh.privateSpec, { ...opts, token: "wrong" }), /token has Contents/);
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

  const { execFileSync } = require("node:child_process");
  for (const dir of [".", "app", "lib", "runtime", "scripts", "test"]) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) execFileSync(process.execPath, ["--check", path.join(dir, f)]);
  }
  const titleOk = (t) => { try { execFileSync(process.execPath, ["scripts/check-commit.js", "--message", t], { stdio: "ignore" }); return true; } catch { return false; } };
  for (const t of ["feat: x", "fix(publish): y", "ci!: z"]) assert(titleOk(t), t);
  for (const t of ["Add thing", "Merge branch x", 'Revert "feat: x"', "", "feat:x"]) assert(!titleOk(t), t);

  console.log("ok:", out);
})();
