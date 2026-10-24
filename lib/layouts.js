// Page layouts (#169): every page has `page.layout`, one of these ids. The
// build gives its <body> class="layout-<id>" plus the markup a layout needs
// (title band, article meta, blog list); themes style them with
// `.layout-<id> …` rules on top of base.css's defaults. Shared by lib/build.js
// (require) and the editor (app/index.html loads this file as a plain script,
// so no Node APIs here).
//
//   sections: the sections "Add page" seeds (the editor adds ids, and fills
//             in form ids and button targets from the site)
//   titleBand: the page title is shown in a band above the sections, unless
//             the first section is a banner (which already acts as the title)
//   fields:   extra page fields the page settings show for this layout
//   thumb:    the chooser's wireframe, a static SVG (theme-independent, so no
//             rendering per theme is needed for a 120x80 sketch)

// Wireframe from [x, y, w, h, dark?] boxes on a 120x80 page with a header bar.
const wire = (boxes) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><rect width="120" height="80" fill="#fff"/><rect width="120" height="8" fill="#cbd5e1"/>${boxes
  .map(([x, y, w, h, dark]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="1" fill="${dark ? "#64748b" : "#e2e8f0"}"/>`).join("")}</svg>`;

const cardsHtml = (heading, items) => `<h2>${heading}</h2>${items.map(([h, p]) => `<h3>${h}</h3><p>${p}</p>`).join("")}`;

const LAYOUTS = [
  { id: "home", label: "Home", description: "Your front page: a big banner, what you offer, about you, reviews and a call to action.",
    sections: [
      { type: "hero", heading: "A big headline", text: "A short sentence about what you do and who you do it for.", buttonText: "Get in touch", buttonPage: "contact" },
      { type: "richtext", cards: true, html: cardsHtml("What we do", [["Service one", "A sentence or two about it."], ["Service two", "A sentence or two about it."], ["Service three", "A sentence or two about it."]]) },
      { type: "text", heading: "About us", text: "Tell visitors who you are, what makes you different, and why they should choose you.", imageLeft: false },
      { type: "richtext", cards: true, html: '<h2>What our customers say</h2><h3>Sam, Bristol</h3><p>"Quick, friendly and great value. I\'d recommend them to anyone."</p><h3>Priya, Bath</h3><p>"They did exactly what they said they would, on time."</p>' },
      { type: "hero", heading: "Ready to talk?", text: "Tell us what you need and we'll get back to you.", buttonText: "Contact us", buttonPage: "contact" },
    ],
    thumb: wire([[0, 8, 120, 26, 1], [8, 38, 32, 14], [44, 38, 32, 14], [80, 38, 32, 14], [8, 56, 50, 8], [62, 56, 50, 8], [0, 68, 120, 12, 1]]) },
  { id: "standard", label: "Standard", description: "Most pages: the page title, then your content.", titleBand: true,
    sections: [{ type: "text", heading: "A heading", text: "Your text here.", imageLeft: false }],
    thumb: wire([[0, 8, 120, 14], [8, 12, 50, 6, 1], [8, 28, 104, 4], [8, 35, 96, 4], [8, 42, 100, 4], [8, 52, 104, 4], [8, 59, 80, 4]]) },
  { id: "landing", label: "Landing", description: "A campaign or offer page: no menu, just the pitch, the benefits and a form.",
    sections: [
      { type: "hero", heading: "One clear offer", text: "Say what visitors get and why it matters to them.", buttonText: "" },
      { type: "richtext", cards: true, html: cardsHtml("Why choose us", [["Benefit one", "What it means for them."], ["Benefit two", "What it means for them."], ["Benefit three", "What it means for them."]]) },
      { type: "form", heading: "Get started today", text: "Leave your details and we'll be in touch.", buttonText: "Send" },
    ],
    thumb: wire([[0, 8, 120, 30, 1], [8, 42, 32, 12], [44, 42, 32, 12], [80, 42, 32, 12], [35, 58, 50, 4], [35, 64, 50, 4], [45, 71, 30, 6, 1]]) },
  { id: "services", label: "Services", description: "What you offer: a short introduction, then a card for each service.", titleBand: true,
    sections: [
      { type: "text", heading: "", text: "A short introduction to what you offer and who it's for.", imageLeft: false },
      { type: "richtext", cards: true, html: cardsHtml("Our services", [["Service one", "What it is, who it's for and what it costs."], ["Service two", "What it is, who it's for and what it costs."], ["Service three", "What it is, who it's for and what it costs."], ["Service four", "What it is, who it's for and what it costs."]]) },
    ],
    thumb: wire([[0, 8, 120, 14], [8, 12, 50, 6, 1], [8, 26, 80, 4], [8, 34, 32, 20], [44, 34, 32, 20], [80, 34, 32, 20], [8, 58, 32, 18], [44, 58, 32, 18]]) },
  { id: "contact", label: "Contact", description: "Get in touch: a form beside your contact details and directions.", titleBand: true,
    sections: [
      { type: "form", heading: "Send us a message", text: "", buttonText: "Send message" },
      { type: "text", heading: "Our details", text: "1 High Street\nYour Town, AB1 2CD\n\nPhone: 01234 567890\nEmail: hello@example.com\n\nOpen Monday to Friday, 9am to 5pm.", imageLeft: false },
      { type: "text", heading: "Find us", text: "Add directions here, and a map image if you like.", imageLeft: false },
    ],
    thumb: wire([[0, 8, 120, 14], [8, 12, 50, 6, 1], [8, 28, 50, 6], [8, 37, 50, 6], [8, 46, 50, 16], [8, 66, 20, 6, 1], [66, 28, 46, 20], [66, 52, 46, 22]]) },
  { id: "blog-post", label: "Blog post", description: "An article with a date, author and featured image, listed on your blog page.", titleBand: true,
    fields: ["date", "author", "featuredImage", "excerpt"],
    sections: [{ type: "richtext", html: "<p>Write your post here.</p>" }],
    thumb: wire([[25, 13, 70, 6, 1], [25, 21, 36, 3], [25, 27, 70, 20], [25, 51, 70, 3], [25, 57, 66, 3], [25, 63, 70, 3], [25, 69, 50, 3]]) },
  { id: "blog-index", label: "Blog", description: "Lists your blog posts automatically, newest first, ten to a page.", titleBand: true,
    sections: [],
    thumb: wire([[0, 8, 120, 14], [8, 12, 40, 6, 1], [8, 27, 28, 14], [40, 28, 50, 4, 1], [40, 35, 70, 3], [8, 46, 28, 14], [40, 47, 50, 4, 1], [40, 54, 70, 3], [8, 65, 28, 14], [40, 66, 50, 4, 1]]) },
  { id: "legal", label: "Legal", description: "Privacy, terms and other plain-text pages, in a narrow, readable column.", titleBand: true,
    sections: [{ type: "richtext", html: "<p>Last updated: </p><h2>A heading</h2><p>Your text here.</p>" }],
    thumb: wire([[25, 13, 50, 6, 1], [25, 25, 70, 3], [25, 31, 66, 3], [25, 37, 70, 3], [25, 46, 40, 4, 1], [25, 54, 70, 3], [25, 60, 62, 3], [25, 66, 70, 3]]) },
];

const LAYOUT = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));

// A page's layout. Pages saved before #169 have none: the first page was the
// home page, the rest standard. Copied (exact-copy) pages have no layout.
const layoutOf = (page, index) => LAYOUT[page.layout] || LAYOUT[index === 0 ? "home" : "standard"];

// Gives every non-copied page a layout. Run on every site read (main.js readSite).
function migrateLayouts(site) {
  if (!site?.pages) return site;
  site.pages.filter((p) => !p.mirror).forEach((p, i) => { if (!LAYOUT[p.layout]) p.layout = layoutOf(p, i).id; });
  return site;
}

if (typeof module !== "undefined") module.exports = { LAYOUTS, LAYOUT, layoutOf, migrateLayouts };
