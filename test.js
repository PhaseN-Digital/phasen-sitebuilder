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
    { id: "d", title: "404", sections: [{ type: "richtext", html: '<p><a href="#page:c">Contact</a> <img src="assets/abc123.webp" alt=""></p>' }] },
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
  assert(!home.includes("turnstile"), "no captcha script on pages without forms");
  const contact = read("public/contact-us.html");
  assert(contact.includes('data-sitekey="SITEKEY"') && contact.includes('name="website"') && contact.includes("turnstile/v0/api.js"));
  assert(read("public/styles.css").includes("--primary-text: #111111"), "dark text on a yellow button");
  assert.strictEqual(JSON.parse(read("worker/forms.json")).contact.to, "owner@example.com");
  assert(read("wrangler.toml").includes("workers_dev = true") && !read("wrangler.toml").includes("custom_domain"));
  assert(read("public/404-2.html").includes('<a href="/contact-us">Contact</a> <img src="/assets/abc123.webp"'), "richtext page links + image paths resolved");
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

  await build({ ...site, domain: { id: "z", name: "bobsbikes.co.uk" } }, siteDir, out, { workerName: "w", hostname: "bobsbikes.co.uk" });
  assert(read("wrangler.toml").includes('pattern = "bobsbikes.co.uk"\ncustom_domain = true') && read("wrangler.toml").includes("workers_dev = false"));

  // Exact-copy import reads WordPress forms' questions from their markup.
  const { formFields } = require("./lib/mirror");
  assert.deepStrictEqual(formFields(`<input type="hidden" name="post_id"><label for="n">Name</label><input id="n" name="f[name]" required>
    <input type="email" name="f[email]" placeholder="Email" aria-required="true"><input type="radio" name="pick" value="a"><input type="radio" name="pick" value="b"><textarea name="msg"></textarea><button type="submit">Go</button>`), [
    { id: "f[name]", label: "Name", type: "text", required: true },
    { id: "f[email]", label: "Email", type: "email", required: true },
    { id: "pick", label: "pick", type: "text", required: false },
    { id: "msg", label: "msg", type: "textarea", required: false },
  ]);
  // Builder detection looks for the builder's markup, not just its name (an image called Elementor-Logo.svg).
  const { detectBuilder } = require("./lib/mirror");
  assert.strictEqual(detectBuilder(`<body class="elementor-kit-5"><div data-elementor-type="wp-page">`), "Elementor");
  assert.strictEqual(detectBuilder(`<img src="/wp-content/uploads/Elementor-Logo.svg">`), null);

  // Syntax-check every script, including the renderer ones nothing above loads.
  const { execFileSync } = require("node:child_process");
  for (const dir of [".", "app", "lib", "runtime", "scripts"]) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) execFileSync(process.execPath, ["--check", path.join(dir, f)]);
  }

  console.log("ok:", out);
})();
