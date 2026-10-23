// Self-check for the site builder: `npm test`. Builds a sample site and
// asserts on the output.
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { build } = require("./lib/build");

const site = {
  id: "test", name: "Bob's <Bikes>", description: "Bikes & repairs", theme: "bold", font: "serif",
  colors: { background: "#ffffff", text: "#111111", primary: "#ffee00", accent: "#000000" },
  logo: null, domain: null, workerName: "bobs-bikes-test",
  pages: [
    { id: "h", title: "Home", sections: [{ type: "hero", heading: "<script>x</script>", text: "Hi\n\nThere", buttonText: "Go", buttonPage: "c" }] },
    { id: "c", title: "Contact Us!", sections: [{ type: "form", formId: "contact", heading: "Ask", buttonText: "Send" }] },
    { id: "d", title: "404", sections: [] },
  ],
  forms: [{ id: "contact", name: "Contact", to: "", success: "Thanks", fields: [
    { id: "name", label: "Name", type: "text", required: true },
    { id: "email", label: "Email", type: "email", required: true },
    { id: "message", label: "Message", type: "textarea", required: false },
  ] }],
};

(async () => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const out = path.join(os.tmpdir(), "sitebuilder-test-out");
  const paths = await build(site, siteDir, out, { workerName: site.workerName, sitekey: "SITEKEY", defaultTo: "owner@example.com" });
  const read = (f) => fs.readFileSync(path.join(out, f), "utf8");

  assert.deepStrictEqual(paths, { h: "/", c: "/contact-us", d: "/404-2" }); // reserved "404" slug deduped
  const home = read("public/index.html");
  assert(home.includes("&lt;script&gt;x&lt;/script&gt;") && !home.includes("<script>x"), "user text is escaped");
  assert(home.includes('href="/contact-us"') && home.includes("<p>Hi</p><p>There</p>"));
  assert(!home.includes("turnstile"), "no captcha script on pages without forms");
  const contact = read("public/contact-us.html");
  assert(contact.includes('data-sitekey="SITEKEY"') && contact.includes('name="website"') && contact.includes("turnstile/v0/api.js"));
  assert(read("public/styles.css").includes("--primary-text: #111111"), "dark text on a yellow button");
  assert.strictEqual(JSON.parse(read("worker/forms.json")).contact.to, "owner@example.com");
  assert(read("wrangler.toml").includes("workers_dev = true") && !read("wrangler.toml").includes("custom_domain"));
  for (const f of ["public/404.html", "public/form.js", "worker/index.js"]) assert(fs.existsSync(path.join(out, f)), f);

  await build({ ...site, domain: { id: "z", name: "bobsbikes.co.uk" } }, siteDir, out, { workerName: "w", hostname: "bobsbikes.co.uk" });
  assert(read("wrangler.toml").includes('pattern = "bobsbikes.co.uk"\ncustom_domain = true') && read("wrangler.toml").includes("workers_dev = false"));

  console.log("ok:", out);
})();
