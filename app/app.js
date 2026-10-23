// The whole editor UI. State lives in `site`; text inputs mutate it in place
// (so typing never loses focus), structural changes call renderTab().
const { call, onPublishLog, onImportLog } = window.cms;

let THEMES, site, publishedUrl, paths = {}, settings;
let tab = "design", pageId = null, formId = null, previewMobile = false, publishing = false, publishLog = "";
const $ = (sel) => document.querySelector(sel);
const rid = () => Math.random().toString(16).slice(2, 10);
const errorText = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}

// ---------- form field helpers ----------
const labelled = (label, control, hint) => h("label", { className: "field" }, h("span", {}, label), control, hint && h("p", { className: "hint" }, hint));
const text = (label, obj, key, hint, props = {}) =>
  labelled(label, h("input", { value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; save(); }, ...props }), hint);
const area = (label, obj, key, hint) =>
  labelled(label, h("textarea", { value: obj[key] ?? "", oninput: (e) => { obj[key] = e.target.value; save(); } }), hint);
const select = (label, obj, key, options, onchange) =>
  labelled(label, h("select", { onchange: (e) => { obj[key] = e.target.value; save(); onchange?.(); } },
    options.map(([value, name]) => h("option", { value, selected: obj[key] === value }, name))));
const check = (label, obj, key) =>
  h("label", { className: "field", style: "display:flex;gap:8px;align-items:center" },
    h("input", { type: "checkbox", checked: Boolean(obj[key]), onchange: (e) => { obj[key] = e.target.checked; save(); } }), label);
const move = (list, i, d) => { const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; save(); renderTab(); };
const thumbUrl = (src) => `preview://${site.id}/${src}`;

// Resize in the browser with canvas: no native image library to package.
async function saveImage(siteId, blob, max) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const webp = await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  return call("images:save", siteId, new Uint8Array(await webp.arrayBuffer()));
}

async function processImage(file, max) {
  try {
    return await saveImage(site.id, file, max);
  } catch {
    alert(`Sorry, "${file.name}" couldn't be used. Try a JPG or PNG photo.`);
    return null;
  }
}

function pickFiles(multiple, onFiles) {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple });
  input.onchange = () => onFiles([...input.files]);
  input.click();
}

function imageField(label, obj, key, max = 1920, hint) {
  const wrap = h("div", { className: "field" });
  const render = () => {
    const image = obj[key];
    const upload = h("button", { type: "button", onclick: () => pickFiles(false, async ([file]) => {
      const src = file && (await processImage(file, max));
      if (!src) return;
      obj[key] = { src, alt: image?.alt || "" };
      save(); render();
    }) }, image ? "Change…" : "Upload image…");
    wrap.replaceChildren(
      h("span", {}, label),
      h("div", { className: "image-field" },
        image ? h("img", { className: "thumb", src: thumbUrl(image.src), alt: "" }) : h("div", { className: "thumb" }),
        h("div", { className: "stack" },
          image && h("input", { value: image.alt, placeholder: "Describe the image (for screen readers)", oninput: (e) => { image.alt = e.target.value; save(); } }),
          h("div", { className: "inline" }, upload, image && h("button", { type: "button", className: "danger", onclick: () => { obj[key] = null; save(); render(); } }, "Remove")))),
      h("p", { className: "hint", hidden: !hint }, hint || "")
    );
  };
  render();
  return wrap;
}

// ---------- saving + preview ----------
let saveTimer;
function save() {
  $(".save-state").textContent = "Saving…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      paths = await call("sites:save", site);
      $(".save-state").textContent = "All changes saved";
      refreshPreview();
      document.querySelector(`#site-list [data-id="${site.id}"]`).textContent = site.name || "Untitled";
    } catch (e) {
      $(".save-state").textContent = `Not saved: ${errorText(e)}`;
    }
  }, 400);
}

function refreshPreview() {
  const frame = $("#preview");
  const editingCopy = tab === "pages" && site.pages.find((p) => p.id === pageId)?.mirror;
  if (frame) frame.src = `preview://${site.id}${paths[pageId] || "/"}?t=${Date.now()}${editingCopy ? "&sb-edit" : ""}`;
}

// ---------- sites ----------
async function loadSites(activeId) {
  const sites = await call("sites:list");
  $("#site-list").replaceChildren(
    ...sites.map((s) => h("button", { className: s.id === activeId ? "active" : "", "data-id": s.id, onclick: () => openSite(s.id) }, s.name || "Untitled"))
  );
}

async function openSite(id) {
  clearTimeout(saveTimer);
  publishLog = "";
  ({ site, url: publishedUrl } = await call("sites:get", id));
  pageId = site.pages[0].id;
  formId = site.forms[0]?.id;
  paths = await call("sites:save", site);
  await loadSites(id);
  renderEditor();
}

$("#new-site").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.name.value;
  e.target.reset();
  const created = await call("sites:create", name, "clean");
  await openSite(created.id);
});

// ---------- layout ----------
function renderEditor() {
  const tabs = [["design", "Design"], ["pages", "Pages"], ["forms", "Forms"], ["publish", "Publish"]];
  $("#main").replaceChildren(
    h("section", { className: "editor-panel" },
      h("header", { className: "panel-head" },
        h("div", { className: "row" }, h("h1", {}, site.name), h("span", { className: "save-state" }, "All changes saved")),
        h("div", { className: "tabs" }, tabs.map(([id, label]) =>
          h("button", { className: tab === id ? "active" : "", onclick: () => { tab = id; selectedCopyImage = null; renderEditor(); } }, label)))),
      h("div", { className: "panel-body", id: "tab" })),
    h("section", { className: `preview${previewMobile ? " mobile" : ""}` },
      h("div", { className: "preview-bar" },
        h("span", {}, "Preview (forms send once published)"),
        h("button", { className: previewMobile ? "" : "primary", onclick: () => { previewMobile = false; renderEditor(); } }, "Desktop"),
        h("button", { className: previewMobile ? "primary" : "", onclick: () => { previewMobile = true; renderEditor(); } }, "Mobile")),
      h("div", { className: "preview-stage" }, h("iframe", { id: "preview", title: "Website preview" })))
  );
  renderTab();
  refreshPreview();
}

function renderTab() {
  const body = $("#tab");
  const scroll = body.scrollTop;
  const content = { design: designTab, pages: pagesTab, forms: formsTab, publish: publishTab }[tab]();
  body.replaceChildren(...content.flat(Infinity).filter((k) => k != null && k !== false));
  body.scrollTop = scroll;
}

// ---------- Design ----------
function designTab() {
  const { themes, fonts } = THEMES;
  return [
    site.mirror && h("div", { className: "warn" }, "Pages copied from WordPress keep their original design. These settings only apply to pages you add here."),
    text("Website name", site, "name"),
    area("Short description", site, "description", "Shown under your site's name in Google search results."),
    h("h3", { className: "section-title" }, "Theme"),
    h("div", { className: "themes" }, Object.entries(themes).map(([id, t]) =>
      h("button", { className: `theme${site.theme === id ? " active" : ""}`, onclick: () => {
        if (site.theme === id) return;
        Object.assign(site, { theme: id, colors: { ...t.colors }, font: t.font });
        save(); renderTab();
      } },
        h("strong", {}, t.label),
        h("div", { className: "swatches" }, Object.values(t.colors).map((c) => h("i", { style: `background:${c}` }))),
        h("small", {}, t.about)))),
    h("p", { className: "hint", style: "margin-top:8px" }, "Picking a theme resets colours and font to that theme's defaults."),
    h("h3", { className: "section-title" }, "Colours"),
    h("div", { className: "grid2" }, [["background", "Background"], ["text", "Text"], ["primary", "Main colour"], ["accent", "Buttons"]].map(([key, label]) =>
      labelled(label, h("input", { type: "color", value: site.colors[key], oninput: (e) => { site.colors[key] = e.target.value; save(); } })))),
    select("Font", site, "font", Object.entries(fonts).map(([id, f]) => [id, f.label])),
    imageField("Logo", site, "logo", 600, "Shown at the top of every page instead of your website name. A wide image with a transparent background works best."),
  ];
}

// ---------- Pages ----------
const SECTION_TYPES = {
  hero: { label: "Banner", make: () => ({ heading: "A big headline", text: "", image: null, buttonText: "", buttonPage: "" }) },
  text: { label: "Text & image", make: () => ({ heading: "A heading", text: "Your text here.", image: null, imageLeft: false }) },
  richtext: { label: "Rich text", make: () => ({ html: "<h2>A heading</h2><p>Your text here.</p>" }) },
  gallery: { label: "Photo gallery", make: () => ({ heading: "Gallery", images: [] }) },
  form: { label: "Form", make: () => ({ heading: "Get in touch", text: "", formId: site.forms[0]?.id || "", buttonText: "Send" }) },
};

function sectionEditor(s) {
  const pageOptions = [["", "(no button)"], ...site.pages.map((p) => [p.id, p.title])];
  switch (s.type) {
    case "hero":
      return [text("Headline", s, "heading"), area("Text", s, "text"), imageField("Background photo", s, "image"),
        h("div", { className: "grid2" }, text("Button text", s, "buttonText"), select("Button goes to", s, "buttonPage", pageOptions))];
    case "text":
      return [text("Heading", s, "heading"), area("Text", s, "text", "Leave a blank line between paragraphs."), imageField("Image (optional)", s, "image"), s.image && check("Show the image on the left", s, "imageLeft")];
    case "gallery": {
      const items = h("div", { className: "gallery-items" }, (s.images || []).map((img, i) =>
        h("div", { className: "image-field" },
          h("img", { className: "thumb", src: thumbUrl(img.src), alt: "" }),
          h("div", { className: "stack" },
            h("input", { value: img.alt, placeholder: "Describe the photo", oninput: (e) => { img.alt = e.target.value; save(); } }),
            h("div", { className: "inline" },
              h("button", { className: "icon", title: "Move up", onclick: () => move(s.images, i, -1) }, "↑"),
              h("button", { className: "icon", title: "Move down", onclick: () => move(s.images, i, 1) }, "↓"),
              h("button", { className: "danger", onclick: () => { s.images.splice(i, 1); save(); renderTab(); } }, "Remove"))))));
      return [text("Heading", s, "heading"), h("div", { className: "field" }, h("span", {}, "Photos"), items,
        h("button", { onclick: () => pickFiles(true, async (files) => {
          for (const file of files) {
            const src = await processImage(file, 1600);
            if (src) (s.images ||= []).push({ src, alt: "" });
          }
          save(); renderTab();
        }) }, "Add photos…"))];
    }
    case "richtext": {
      // Stored images are "assets/x.webp"; the editor shows them via preview://.
      const viewPrefix = `preview://${site.id}/assets/`;
      const editor = h("div", { className: "rich", contentEditable: "true", innerHTML: s.html.replaceAll('src="assets/', `src="${viewPrefix}`),
        oninput: () => { s.html = sanitizeHtml(editor.innerHTML.replaceAll(viewPrefix, "assets/")); save(); } });
      const tool = (label, command, arg) => h("button", { className: "icon", title: label, onmousedown: (e) => { e.preventDefault(); document.execCommand(command, false, arg); } }, label);
      return [h("div", { className: "inline toolbar" }, tool("Bold", "bold"), tool("Italic", "italic"), tool("Heading", "formatBlock", "h2"),
        tool("Subheading", "formatBlock", "h3"), tool("Paragraph", "formatBlock", "p"), tool("• List", "insertUnorderedList"), tool("1. List", "insertOrderedList")), editor];
    }
    case "form":
      return [select("Which form", s, "formId", site.forms.map((f) => [f.id, f.name])), text("Heading", s, "heading"), area("Text above the form", s, "text"), text("Button text", s, "buttonText"),
        h("p", { className: "hint" }, "Edit the form's questions in the Forms tab.")];
  }
}

function pagesTab() {
  const page = site.pages.find((p) => p.id === pageId) || site.pages[0];
  const index = site.pages.indexOf(page);
  const copied = page.mirror && copiedPageCard(page);
  return [
    h("div", { className: "chips" },
      site.pages.map((p) => h("button", { className: p === page ? "active" : "", onclick: () => { pageId = p.id; selectedCopyImage = null; renderTab(); refreshPreview(); } }, p.title || "Untitled")),
      h("button", { onclick: () => {
        const p = { id: rid(), title: "New page", sections: [{ id: rid(), type: "text", ...SECTION_TYPES.text.make() }] };
        site.pages.push(p); pageId = p.id; save(); renderTab();
      } }, "+ Add page")),
    copied || [h("div", { className: "card" },
      text("Page name", page, "title", index === 0 ? "This is your home page. Its name appears in the menu." : "Appears in the menu and the page address."),
      h("div", { className: "inline" },
        h("button", { disabled: index === 0, onclick: () => move(site.pages, index, -1) }, "Move left in menu"),
        h("button", { disabled: index === site.pages.length - 1, onclick: () => move(site.pages, index, 1) }, "Move right"),
        h("button", { className: "danger", disabled: site.pages.length === 1, onclick: () => {
          if (!confirm(`Delete the "${page.title}" page?`)) return;
          site.pages.splice(index, 1); pageId = site.pages[0].id; save(); renderTab();
        } }, "Delete page")),
      index === 0 && h("p", { className: "hint", style: "margin-top:8px" }, "The first page in the menu is always the home page.")),
    h("h3", { className: "section-title" }, "Sections on this page"),
    page.sections.map((s, i) =>
      h("div", { className: "card" },
        h("div", { className: "card-head" },
          h("strong", {}, SECTION_TYPES[s.type].label),
          h("button", { className: "icon", title: "Move up", onclick: () => move(page.sections, i, -1) }, "↑"),
          h("button", { className: "icon", title: "Move down", onclick: () => move(page.sections, i, 1) }, "↓"),
          h("button", { className: "icon danger", title: "Delete section", onclick: () => {
            if (confirm("Delete this section?")) { page.sections.splice(i, 1); save(); renderTab(); }
          } }, "✕")),
        sectionEditor(s))),
    h("div", { className: "adders" }, Object.entries(SECTION_TYPES).map(([type, t]) =>
      h("button", { onclick: () => { page.sections.push({ id: rid(), type, ...t.make() }); save(); renderTab(); } }, `+ ${t.label}`)))],
  ];
}

// ---------- Forms ----------
const FIELD_TYPES = [["text", "Short text"], ["email", "Email"], ["tel", "Phone"], ["textarea", "Long text"]];

function formsTab() {
  const form = site.forms.find((f) => f.id === formId) || site.forms[0];
  const chips = h("div", { className: "chips" },
    site.forms.map((f) => h("button", { className: f === form ? "active" : "", onclick: () => { formId = f.id; renderTab(); } }, f.name || "Untitled")),
    h("button", { onclick: () => {
      const f = { id: rid(), name: "New form", to: "", success: "Thanks, your message has been sent.", fields: [
        { id: rid(), label: "Your name", type: "text", required: true }, { id: rid(), label: "Email address", type: "email", required: true }] };
      site.forms.push(f); formId = f.id; save(); renderTab();
    } }, "+ New form"));
  if (!form) return [chips, h("p", {}, "No forms yet.")];

  const used = [...(form.shownOn || []), ...site.pages.filter((p) => p.sections.some((s) => s.type === "form" && s.formId === form.id)).map((p) => p.title)];
  return [
    chips,
    h("p", { className: "hint" }, used.length ? `Shown on: ${used.join(", ")}` : "Not on any page yet. Add a Form section in the Pages tab to show it."),
    text("Form name", form, "name", "Used in the email subject so you know which form was filled in."),
    text("Send messages to", form, "to", "Leave blank to use the address in Publish › Form messages.", { type: "email", placeholder: settings.email || "you@example.com" }),
    text("Thank-you message", form, "success"),
    h("h3", { className: "section-title" }, "Questions"),
    form.mirrored ? [
      h("p", { className: "hint" }, "This form was copied with your WordPress design, so its questions are set by the page and can't be changed here."),
      h("ul", {}, form.fields.map((f) => h("li", {}, `${f.label}${f.required ? " (required)" : ""}`))),
    ] : [form.fields.map((f, i) =>
      h("div", { className: "field-row" },
        h("input", { value: f.label, "aria-label": "Question", oninput: (e) => { f.label = e.target.value; save(); } }),
        h("select", { "aria-label": "Answer type", onchange: (e) => { f.type = e.target.value; save(); } },
          FIELD_TYPES.map(([v, n]) => h("option", { value: v, selected: f.type === v }, n))),
        h("label", {}, h("input", { type: "checkbox", checked: f.required, onchange: (e) => { f.required = e.target.checked; save(); } }), "Required"),
        h("button", { className: "icon", title: "Move up", onclick: () => move(form.fields, i, -1) }, "↑"),
        h("button", { className: "icon", title: "Move down", onclick: () => move(form.fields, i, 1) }, "↓"),
        h("button", { className: "icon danger", title: "Delete question", disabled: form.fields.length === 1, onclick: () => { form.fields.splice(i, 1); save(); renderTab(); } }, "✕"))),
    h("button", { onclick: () => { form.fields.push({ id: rid(), label: "New question", type: "text", required: false }); save(); renderTab(); } }, "+ Add question")],
    h("hr", { style: "margin:24px 0;border:0;border-top:1px solid var(--line)" }),
    h("button", { className: "danger", disabled: Boolean(form.mirrored), onclick: () => {
      if (!confirm(`Delete the "${form.name}" form?${used.length ? " It will disappear from your pages." : ""}`)) return;
      site.forms.splice(site.forms.indexOf(form), 1); formId = site.forms[0]?.id; save(); renderTab();
    } }, "Delete this form"),
  ];
}

// ---------- Publish ----------
function step(title, done, ...content) {
  return h("div", { className: `step${done ? " done" : ""}` }, h("h3", {}, title), content);
}

function secretInput(placeholder, channel, button) {
  const input = h("input", { type: "password", placeholder });
  const error = h("p", { className: "error" });
  const btn = h("button", { className: "primary", onclick: async () => {
    btn.disabled = true; error.textContent = "";
    try { settings = await call(channel, input.value); renderTab(); }
    catch (e) { error.textContent = errorText(e); btn.disabled = false; }
  } }, button);
  return [h("div", { className: "inline" }, input, btn), error];
}

const link = (label, url) => h("a", { onclick: () => call("open", url) }, label);

function publishTab() {
  const cfDone = Boolean(settings.cloudflare);
  let zones = [];
  const domainSelect = h("select", { disabled: !cfDone, onchange: (e) => {
    const zone = zones.find((z) => z.id === e.target.value);
    site.domain = zone || null; save(); renderTab();
  } }, h("option", { value: "" }, "Free address (…workers.dev)"),
    site.domain && h("option", { value: site.domain.id, selected: true }, site.domain.name));
  if (cfDone) call("zones").then((z) => {
    zones = z;
    domainSelect.append(...z.filter((zone) => zone.id !== site.domain?.id).map((zone) => h("option", { value: zone.id }, zone.name)));
  }).catch(() => {});

  const log = h("pre", { className: "log", hidden: !publishLog }, publishLog);
  const status = h("p", { className: "error" });
  const publishBtn = h("button", { className: "primary big", disabled: publishing || !cfDone || !settings.resend, onclick: async () => {
    publishing = true; publishBtn.disabled = true; status.textContent = ""; log.hidden = false; log.textContent = publishLog = "";
    logSink = (line) => { publishLog += line; log.textContent = publishLog; log.scrollTop = log.scrollHeight; };
    try {
      clearTimeout(saveTimer);
      paths = await call("sites:save", site);
      publishedUrl = await call("sites:publish", site.id);
      publishing = false;
      renderTab();
    } catch (e) {
      status.textContent = errorText(e);
      publishing = false; publishBtn.disabled = false;
    }
  } }, publishedUrl ? "Publish changes" : "Publish website");

  return [
    publishedUrl && h("div", { className: "live" }, "Your website is live at ", link(publishedUrl, publishedUrl)),
    step("1. Cloudflare (hosting)", cfDone,
      cfDone
        ? [
            settings.cloudflare.accounts.length > 1 && labelled("Account", h("select", { onchange: async (e) => { settings = await call("settings:account", e.target.value); renderTab(); } },
              settings.cloudflare.accounts.map((a) => h("option", { value: a.id, selected: a.id === settings.cloudflare.accountId }, a.name)))),
            settings.cloudflare.warnings?.map((w) => h("div", { className: "warn" }, w)),
            h("button", { onclick: async () => { settings = await call("settings:disconnect", "cloudflare"); renderTab(); } }, "Disconnect"),
          ]
        : [
            h("ol", {},
              h("li", {}, "Create a free account at ", link("cloudflare.com", "https://dash.cloudflare.com/sign-up"), " (skip if you have one)."),
              h("li", {}, "Open ", link("API Tokens", "https://dash.cloudflare.com/profile/api-tokens"), " and click ", h("b", {}, "Create Token"), "."),
              h("li", {}, "Next to ", h("b", {}, "Edit Cloudflare Workers"), " click ", h("b", {}, "Use template"), "."),
              h("li", {}, "Click ", h("b", {}, "+ Add more"), " and add ", h("b", {}, "Account · Turnstile · Edit"), ", then ", h("b", {}, "Zone · DNS · Edit"), "."),
              h("li", {}, "Set Account Resources and Zone Resources to ", h("b", {}, "All"), ", then ", h("b", {}, "Continue to summary › Create Token"), "."),
              h("li", {}, "Copy the token and paste it here.")),
            secretInput("Paste your Cloudflare API token", "settings:cloudflare", "Connect"),
          ]),
    step("2. Resend (sends your form emails)", settings.resend,
      settings.resend
        ? h("button", { onclick: async () => { settings = await call("settings:disconnect", "resend"); renderTab(); } }, "Disconnect")
        : [
            h("ol", {},
              h("li", {}, "Create a free account at ", link("resend.com", "https://resend.com/signup"), "."),
              h("li", {}, "Open ", link("API Keys", "https://resend.com/api-keys"), ", click ", h("b", {}, "Create API Key"), " and choose ", h("b", {}, "Full access"), "."),
              h("li", {}, "Copy the key and paste it here.")),
            secretInput("Paste your Resend API key", "settings:resend", "Connect"),
          ]),
    step("3. Form messages", Boolean(settings.email),
      labelled("Send form messages to", h("input", { type: "email", value: settings.email, placeholder: "you@example.com",
        onchange: async (e) => { settings = await call("settings:email", e.target.value); renderTab(); } }),
        site.domain ? "" : "Until you use your own domain, this must be the same email you signed up to Resend with.")),
    step("4. Web address", false,
      labelled("Domain", domainSelect,
        site.domain
          ? `Your site will be at https://${site.domain.name}. Email records are added for you automatically.`
          : ["To use your own domain, first ", link("add it to Cloudflare", "https://dash.cloudflare.com/?to=/:account/add-site"), ", then come back here."])),
    paths.privacy && step("5. Privacy page", Boolean(site.privacy?.owner),
      h("p", {}, "Because your site has a form, it gets a privacy page at ", h("b", {}, `${publishedUrl || ""}${paths.privacy}`), ". ",
        site.mirror ? "Copied pages keep their own footer, so add a link to it there if you can." : "It's linked from the footer of every page.",
        " It uses the email address form messages are sent to."),
      h("div", { className: "warn" }, "This is a starting point, not legal advice. Read it and check it matches how you handle people's information.",
        site.mirror ? " Copied pages may also load other services (analytics, maps, videos) that it doesn't mention." : ""),
      text("Business or legal name", site.privacy ||= {}, "owner", "Who's responsible for the information people send, e.g. \"Smith Plumbing Ltd\" or \"Jane Smith, trading as Smith Plumbing\". Leave blank to use the website name.", { placeholder: site.name }),
      area("How long you keep messages", site.privacy, "retention", "Leave blank to say you keep them only as long as you need to deal with the enquiry."),
      h("button", { onclick: () => { $("#preview").src = `preview://${site.id}${paths.privacy}?t=${Date.now()}`; } }, "Show it in the preview")),
    h("div", { className: "inline", style: "align-items:center;margin-top:8px" }, publishBtn,
      h("button", { onclick: async () => { try { await call("sites:export", site.id); } catch (e) { status.textContent = errorText(e); } } }, "Save as package…")),
    status,
    log,
    h("hr", { style: "margin:32px 0 16px;border:0;border-top:1px solid var(--line)" }),
    h("button", { className: "danger", onclick: async () => {
      if (!confirm(`Delete "${site.name}" from this computer? ${publishedUrl ? "The live website stays online; remove it in the Cloudflare dashboard if you no longer need it." : ""}`)) return;
      clearTimeout(saveTimer);
      await call("sites:delete", site.id);
      site = null;
      $("#main").replaceChildren(h("div", { className: "welcome" }, h("h1", {}, "Website deleted")));
      loadSites();
    } }, "Delete this website"),
  ];
}

let logSink = () => {};
onPublishLog((line) => logSink(line));

(async () => {
  [THEMES, settings] = await Promise.all([call("themes"), call("settings:get")]);
  await loadSites();
})();
