# PhaseN Site Builder

Desktop app (Windows/macOS) for building small business websites and publishing
them to Cloudflare, with no command line. Each site it produces has the same
shape as phasen.digital: a single Cloudflare Worker serving static assets plus a
form API (`POST /api/forms/<id>`) with honeypot, Turnstile and Resend email.

```
npm install
npm start        # run the app
npm test         # builder self-check
npm run test:regression   # end-to-end suite, see "Regression tests"
npm run dist     # installer for the current OS (.exe on Windows, .dmg on macOS)
```

Users download installers from the public
[phasen-sitebuilder-releases](https://github.com/PhaseN-Digital/phasen-sitebuilder-releases/releases/latest)
repo (this one is private), see "Commits and releases".

## Roadmap and issues

Bugs, features and the roadmap live in the
[PhaseN Site Builder project](https://github.com/orgs/PhaseN-Digital/projects/3)
(Priority P0/P1/P2, Status Todo → In Progress → Testing → Done). File issues
with the bug/feature forms, which add them to the project automatically.
CLAUDE.md describes how changes are tracked.

## Commits and releases

Changes go through PRs only, never direct commits to `main` (a `pre-commit`
hook refuses them). Commit messages must follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat: …`, `fix(publish): …`, `feat!: …` for breaking changes).
release-please silently skips anything else, so the change would be missing
from the changelog and version bump. `npm install` sets up a `commit-msg` hook
(`.githooks/`) that checks this locally; CI checks every commit in a PR and the PR title. PRs
are squash merged, so the PR title becomes the commit on `main`. Both
use `scripts/check-commit.js`.

- `ci.yml`: `npm test` on every PR and push to `main`, plus the commit check
  on PRs.
- `regression.yml`: `npm run test:regression` on release-please's release
  PRs (branches starting `release-please--`), by hand ("Run workflow") and
  via `workflow_call`. On failure the screenshots, wrangler logs and
  results are uploaded as the `regression-output` artifact.
- `release-please.yml`: maintains a release PR (version bump in
  `package.json`, `CHANGELOG.md`). Merging it creates the GitHub release, and
  the `build` job then builds the Windows installer and the macOS installers
  (`…-arm64.dmg` for Apple Silicon, `…-x64.dmg` for Intel) and attaches
  them to it. Running the workflow by hand ("Run workflow") builds
  installers as run artifacts without releasing. Builds live in this
  workflow, not a tag-triggered one, because GitHub won't trigger workflows
  from release-please's `GITHUB_TOKEN` tags.
- Release gate: whenever release-please opens or updates the release PR,
  the same run calls `regression.yml` on the PR's head. A **patch** release
  (`scripts/release-bump.js`: same major.minor) that passes is merged by the
  workflow and released and built in that same run. A **minor/major**
  release that passes gets the `needs-approval` label and a comment, and is
  released when the maintainer merges it. A failure gets the
  `regression-failed` label and a comment, and is never merged. The gate
  only merges if `main` is still exactly what the regression run tested
  against (#97); if anything landed on `main` meanwhile it comments and
  leaves the PR to the next run, which re-gates it with the new commits. This all
  happens in one run because release-please's PR updates and a
  `GITHUB_TOKEN` merge don't trigger other workflow runs.
- Public downloads and update check (#37): once `build` succeeds for a
  release, `publish-installers` copies the installers and a generated
  `latest.json` (`version`, `notes` URL, `downloads` keyed
  `<platform>-<arch>`: `win32-x64`, `darwin-arm64`, `darwin-x64`) to a
  release with the same tag in the public
  `PhaseN-Digital/phasen-sitebuilder-releases` repo, with this release's
  changelog section as its notes. No source goes there. It authenticates
  with the `RELEASES_TOKEN` secret (fine-grained, Contents read/write on
  that repo only). The app fetches
  `releases/latest/download/latest.json` from it at startup, at most once a
  day (`updateCheck` in settings.json), and if that version is newer shows a
  dismissible "Version X is available" banner in the sidebar whose Download
  button opens the installer for this platform in the browser (only https
  github.com URLs). Offline or any error, it stays silent and tries again
  next time. `SITEBUILDER_UPDATE_URL` overrides the URL in unpackaged runs
  only (the regression suite uses it).
- Code signing switches on per OS once that OS's certificate secret exists
  (repo Settings > Secrets and variables > Actions); without it the
  installer is built unsigned, as now. macOS: `CSC_LINK` (base64 of a
  Developer ID Application .p12) and `CSC_KEY_PASSWORD`, plus `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarisation.
  Windows: `WIN_CSC_LINK` (base64 .pfx) and `WIN_CSC_KEY_PASSWORD`; Azure
  Trusted Signing or a cloud-HSM certificate needs extra config (#32).

## Regression tests

`npm run test:regression` (`test/regression.js`, about 10 seconds locally)
checks the whole app end to end with no accounts, against fake sites in
`test/fakes.js`:

- the real app, driven headlessly by `test/drive.js`: the update banner
  (from a fake `latest.json`), create a site, preview,
  edit + rebuild, theme switch, image upload (theme sources point at a fake
  GitHub API with a public and a token-protected repo, so nothing reaches
  GitHub); editable WordPress import from
  a fake WordPress (REST, global styles, hostile HTML) and of a fake
  Elementor site (kit colours/font, header logo); exact copy of a fake
  Elementor site (no origin URLs left, forms re-wired, copy vs structure
  tagging, page edit, site-wide edit, image replace, undo, revert);
- the sites it made, built as publishing builds them and run under the
  bundled `wrangler dev` (on Electron's Node): pages, uploaded images, 404s,
  a theme from a theme source (downloaded from the fake GitHub API, then
  built from the site's own copy), the copied site's redirect, and form POSTs (honeypot, validation, captcha,
  a valid message logged instead of emailed since `RESEND_API_KEY` is unset).

It prints one line per check and a summary, and exits non-zero on any
failure. On Linux without a display it runs Electron under `xvfb-run`
(`apt install xvfb`). Set `SB_OUT=<dir>` to keep the output somewhere
fixed; otherwise it's a temp folder, named in the summary. The Worker's
Turnstile check calls Cloudflare's real siteverify endpoint with the
published always-pass test secret, so that one step needs internet access.

## How it fits together

- `main.js`: Electron main process. Stores sites under the app's user-data
  folder (`sites/<id>/site.json` + `assets/`; uploads nothing uses any more
  are left out of published/exported sites and deleted at the next startup
  once a day old), serves the live preview through a
  `preview://` protocol, and holds API keys encrypted with the OS keychain
  (`safeStorage`).
- `app/`: the editor UI (plain HTML/CSS/JS, no framework). `app/wordpress.js`
  is the WordPress import screen and HTML sanitizer; `app/copied.js` and
  `app/copy-edit-frame.js` edit exact-copy pages.
- `lib/build.js`: `site.json` → `public/`, `worker/`, `wrangler.toml`. The
  preview, publish and "Save as package" all use it.
- `lib/publish.js`: Cloudflare and Resend API calls, plus the bundled
  wrangler. Wrangler runs on Electron's own Node via `ELECTRON_RUN_AS_NODE`, so
  users install nothing else. `lib/wrangler-argv-fix.js` is required for that
  to work, see the comment in it.
- `runtime/`: the form Worker and browser script copied into every site.
- `themes/`: `base.css`, `fonts.json` (the Font choices) and one package per
  theme, `themes/<id>/theme.json` (label, about, colours, font id or CSS font
  stack, optional version) plus `theme.css` (small overrides on top of
  `base.css`; CSS only, no JS or HTML). Below 760px `base.css` collapses the
  header nav behind a Menu button (a small inline script in `lib/build.js`
  adds it; without JS the nav just stays visible). `lib/themes.js` loads them for both
  the build and the Design tab; colours/fonts are CSS variables the user picks
  there. `lib/theme-validate.js` checks a package (`node lib/theme-validate.js
  themes`); an identical copy is vendored into the public
  [phasen-sitebuilder-themes](https://github.com/PhaseN-Digital/phasen-sitebuilder-themes)
  repo for its CI, so **keep the two copies in sync**: change both together.
- Theme sources (`lib/theme-sources.js`, Design tab › Theme sources): extra
  themes from GitHub repos. The public
  [phasen-sitebuilder-themes](https://github.com/PhaseN-Digital/phasen-sitebuilder-themes)
  repo is always listed (it can be hidden, not removed); users add
  `owner/repo`, optionally `owner/repo/folder@branch` (default folder:
  `themes/` if present, else the repo root). Each source is downloaded as one
  tarball through the GitHub REST API (one request per refresh, so the
  unauthenticated 60/hour limit goes a long way), every theme in it is
  validated with `lib/theme-validate.js`, and the result is cached in
  `userData/theme-cache`. Private repos use a fine-grained token (Contents:
  Read-only) saved per source with `safeStorage`; it's only ever sent to
  api.github.com, and the download link GitHub redirects to is fetched
  without it. Choosing a theme copies it to `sites/<id>/theme/` and sets
  `site.themeSource`, so builds and publishes never need the repo or the
  cache; "Update theme" downloads the source again and replaces the copy
  (colours and font stay as the user set them).

## Privacy page

Sites with a form (built-in or copied) get a generated, `noindex` privacy
notice at `/privacy` (`renderPrivacy` in `lib/build.js`), linked from the
footer of built pages. It names the business, the contact email (the first
used form's "Send messages to", else Publish › Form messages), what each form
collects, Cloudflare/Turnstile and Resend as processors, how long messages
are kept and the visitor's UK GDPR rights. The business name and retention
sentence are set in Publish › Privacy page, which says it's a starting point,
not legal advice. Exact-copy pages keep their own footer, so there the user
is told the address and adds the link themselves; the notice doesn't cover
third-party services the copied pages load.

## Analytics and cookie consent

Design › Google Analytics measurement ID (optional, `site.analyticsId`, must
look like `G-XXXX`, anything else is ignored). When set, every page built
from the site's own themes gets a cookie banner and `runtime/consent.js`
(copied to `/consent.js`, ID passed in `data-ga-id`). Following UK PECR, the
Google tag only loads after the visitor clicks Accept; the choice is kept in
`localStorage` and a footer "Cookie preferences" link reopens the banner.
Nothing loads in the in-app preview. The site then always gets the privacy
page, which gains an "Analytics and cookies" section (and drops the form
parts if there are no forms). Exact-copy pages don't get the banner (#45).

## Search and sharing (SEO)

Pages › Search and sharing sets a page's search title (`page.seoTitle`,
default "Page | Site", or the site name on the home page), description
(`page.seoDescription`, default Design › Short description) and social share
image (`page.shareImage`, picked from the site's uploads, default the logo).
`renderPage` turns these into `<title>`, the meta description, Open Graph and
Twitter tags. `canonical`, `og:url`, absolute image URLs, `sitemap.xml` and
`robots.txt` need the published hostname, so `build()` only writes them when
given `publish.hostname` (always the case when publishing, only with a domain
on export) and never in the preview. The sitemap lists every indexable page
(not the noindex privacy page or 404). An exact copy downloads the original
site's `robots.txt` and `/sitemap.xml` (not for a subfolder copy), keeping
only sitemap entries for pages that were copied and pointing robots.txt's
`Sitemap:` line at the copy's own; a sitemap index (WordPress's and Yoast's
usual one) isn't copied, and the sitemap then lists the copied pages,
skipping any whose HTML has a `noindex` meta tag. Copied pages keep their own
`<head>` tags, but `lib/mirror.js` makes their canonical, `og:url`,
`og:image` and Twitter URL/image tags root-relative (a canonical naming
another host keeps just its path) and `build()`'s `absolutise()` puts the
published hostname back in front, in those tags and in the copied
robots.txt/sitemap.xml (#115). Without a hostname they stay root-relative.

## Importing from WordPress

"Import from WordPress…" offers two kinds of import. "Decide for me" picks an
exact copy when the home page shows a page builder (Elementor, Divi, Beaver
Builder, WPBakery, Bricks, Oxygen, Avada; detected from the builder's own
markup) or there's no REST API (including one hidden from visitors when no
username and application password were given), and the editable import
otherwise.

### Exact copy (`lib/mirror.js`)

Crawls the rendered site from the address given (same-site links only, up to
500 pages and 5,000 files) and saves each page's HTML plus every same-site CSS, JS, font
and image at its original path under `sites/<id>/mirror/`. Since paths are
kept, the only rewrite needed is stripping the site's domain from URLs
(including JSON-escaped ones in inline scripts), so links, CSS `url()`s and
srcsets keep working. Redirects found while crawling go into Cloudflare's
`_redirects` file, and WordPress's own 404 page is copied (with its own
stylesheets and images).

The original site's tracking is dropped from the copy, since it would report
to the old site's accounts without the new site's visitors' consent: any
`<script>`, `<noscript>` or `<link>` matching the `TRACKERS` table in
`lib/mirror.js` (Google Analytics/Tag Manager, Facebook pixel, Hotjar,
Microsoft Clarity, LinkedIn Insight, TikTok pixel, Microsoft Ads) is removed,
and the import log says which were found. Google Fonts stylesheets
(`fonts.googleapis.com`, in pages or CSS `@import`s) and their font files are
downloaded into `/google-fonts/` in the copy, with Google preconnect hints
removed, so visitors' browsers never contact Google for them. A stylesheet
that can't be downloaded is logged, and its fonts fall back.

A WordPress installed in a subfolder (`example.com/blog/`) is copied from that
folder only: its pages keep their `/blog/...` paths, so addresses match the old
site, and the copy's `/` redirects to `/blog/`. The folder is taken from the
address given, so giving an inner page's address (`example.com/about/`)
copies only that part of the site. Tried only against a fake subfolder site
so far (`test/fakes.js`).

POST forms are re-wired in place, keeping their markup and styling: the
questions are read from the form's fields, and the form gets a `data-form`
id, honeypot and Turnstile widget. The same form on many pages (a footer
newsletter form) becomes one form. Log-in, search, cart/checkout and comment
forms (by password field, class or WordPress field names) are left alone.
Plugin honeypot fields (Akismet, Fluent Forms) aren't questions. Fields
inside an element hidden when the page loads (conditional branches: inline
`display:none`, `hidden`, Fluent's `has-conditions`, Gravity/Divi
`data-conditional-logic`) aren't required, in the Worker or in the markup.
Checkboxes, radios and selects are `choice` questions; a ticked checkbox
group or multi-select is posted as an array and joined in the email.
A question's wording comes from its `<label>` (by `for` or wrapping it),
`aria-labelledby`, `aria-label`, text just before it in the same paragraph
(Contact Form 7's `<p>Your Message<br><textarea>`), its placeholder, and
last a tidied field name (`your-message` becomes "Your message"). Copied
questions can't be renamed in the app yet.
`runtime/form.js` listens in the capture
phase so the page builder's own submit handler (which would post to
WordPress) never runs. Turnstile key and thank-you message are filled in at
build time.

Copied pages are edited in place in the preview (Pages tab). `app/copied.js`
separates copy from theme structure once, right after import: it tags text
blocks (headings, paragraphs, list items, button text, page-builder text
widgets that don't contain a form) and images with a `data-sb-edit` key. Anything inside the header,
menu, footer or sidebar (landmarks plus Elementor/Divi/Beaver/theme
conventions) gets a site-wide `s-` key derived from its original text, so the
same menu item or logo matches on every page and an edit there is applied to
all of them. Everything else gets a per-page `p-` key. Layout elements are
never tagged. `app/copy-edit-frame.js` is injected into the preview to make
tagged elements editable. Edits are written into the stored HTML (not the
live DOM, which page scripts have modified), and the build strips the tags.
Clicking a tagged text element that is (or is inside, or holds exactly one)
link also shows a Link panel for changing where it points, applied like any
other edit (site-wide for `s-` keys, undoable). Targets must be an http(s)
address, `mailto:`, `tel:` or a copied page's path. Links on images (e.g. a
logo) can't be changed yet.
Before a page's file is first edited, its HTML is kept in
`sites/<id>/mirror-original/`, for "Revert this page to the original" (which
also drops that page's share of site-wide edits; they stay on other pages).
"Undo last change" restores every file the last edit or revert wrote,
from an in-memory stack of 20 per site, so undo history is lost when the app
restarts. Sites edited before this existed keep their state at the first edit
since then as the "original".

Not copied: anything only reachable
via a query string (`?p=123` permalinks, search results), files only loaded
by JS at runtime (some page-builder widget scripts), feeds, file uploads in
forms. Third-party assets (Google Fonts, CDNs) stay remote.

### Editable import

Uses the WordPress REST API. Credentials (username + application password) are optional:
only needed if the site blocks public REST access, and only used once the
site refuses an anonymous request, because pages fetched with them are
rendered as that (admin) user (login/account shortcodes would show "You're
already signed in"). They're only sent over https and aren't stored.

- Content: every published page becomes a page with a "Rich text" section.
  `lib/wordpress.js` fetches; `app/wordpress.js` sanitizes with an allowlist
  (scripts, iframes, forms, inline styles/handlers and `javascript:` links
  are removed). Images are downloaded and re-encoded like uploads. Links
  between imported pages are rewritten to the new pages; other links (posts,
  files) keep pointing at the old site.
- Addresses: each page keeps its WordPress address (`page.path`, e.g.
  `/our-services/` or `/services/web/`), so old links and search results
  still work, and renaming the page doesn't move it. Where an address can't
  be kept (the home page, which is always `/`; a non-ASCII or reserved slug
  such as `/api/`), the page gets a title-based address and the old one a
  301 in `_redirects`. Pages added in the app use title-based addresses.
- Pages that contained a WordPress form (Contact Form 7 etc.) get the
  built-in contact form instead.
- "Theme": WordPress themes are PHP, so only the name, tagline, logo,
  colours and font style are copied, from the home page's global styles
  (block themes; WordPress's own default button colour is ignored), or
  failing that from Elementor's kit stylesheet (global colours and primary
  font; serif is guessed from a short list of font names). The logo is the
  theme's custom logo, else the first image in an Elementor header. Classic
  themes and other page builders mostly don't expose these, so they get a
  built-in theme's defaults.
- Some plugins print HTML before the REST API's JSON; that's skipped.
- Not imported: blog posts, menus (page order follows WordPress's page
  order), page layouts, plugins.

## What publishing does

1. Uses the workers.dev subdomain, or the chosen Cloudflare zone as a Custom
   Domain.
2. Creates/updates a Turnstile widget for that hostname.
3. With a custom domain: registers it with Resend and writes Resend's DNS
   records into the zone (scoped to `send.<domain>`, so existing mailboxes are
   untouched). Without one, forms send from `onboarding@resend.dev`, which
   Resend only delivers to the Resend account owner's email.
4. Creates a sending-only Resend key for the site's Worker.
5. `wrangler deploy`, then `wrangler secret bulk` for the Turnstile secret and
   Resend key.
6. With a custom domain: a proxied `www` CNAME and a 301 Single Redirect rule
   (`http_request_dynamic_redirect` phase) sending `www.<domain>` to the apex,
   as phasen.digital's Terraform does. An existing `www` record or existing
   redirect rules are left alone (logged, not overwritten). If this step fails,
   e.g. the token lacks the permission, publishing still succeeds and the log
   says why.

The Cloudflare token needs the "Edit Cloudflare Workers" template plus
Account › Turnstile › Edit, Zone › DNS › Edit and Zone › Single Redirect ›
Edit (Dynamic Redirect on some accounts, needed for the `www` redirect). The app lists these steps
in the Publish tab.

## Known gaps

- Release gate: GitHub's merge API can't require an unchanged base, so a
  push to `main` in the second between the gate's last check and its merge
  still lands under the squash. The gate catches it and doesn't release from
  that run, but the next run would (#99).

- Theme sources: a public-repo theme with the same id as a built-in one is
  hidden (the built-in wins), so built-in themes can't be updated from the
  repo. Sources are only downloaded when first listed, on "Refresh" and on
  "Update theme"; there's no automatic check for newer versions. Tested
  against a fake GitHub API and the real public repo, not yet with a real
  private repo and token.

- Updates are notify-only: the user downloads and runs the new installer
  themselves. Silent auto-update (electron-updater) needs signed macOS
  builds (#6). Dismissing the banner lasts until the app restarts.

- Installers are unsigned until the signing secrets are added (see "Commits
  and releases"): Windows SmartScreen and macOS Gatekeeper will warn. Signing
  is wired up but untested, since no certificates exist yet (#6).
- `asar` is off, so installs are still about 330 MB unpacked (mostly
  Electron). workerd's binary, which only `wrangler dev` runs, is replaced
  with a stub at package time (`scripts/after-pack.js`), so the packaged app
  can't run `wrangler dev`.
- Analytics consent covers only pages built from the themes, and only Google
  Analytics. Exact-copy pages lose the original site's tracking (#45) but
  don't get the consent banner or the site's own measurement ID yet (#103).
- Imports have been tried against a handful of public WordPress sites
  (Elementor, Divi, block theme, classic theme with the REST API hidden) and
  one Elementor 4 site of the maintainer's own (both imports, with an
  application password), but not yet against a client site. Known problems
  from that: conditional-field detection in re-wired forms is built from
  plugin markup conventions, not yet re-tested on a real Gravity, Fluent or
  Divi conditional form (#22); editable import of Divi/WPBakery pages, block-theme home pages and SVG logos (#24);
  Elementor 3 runtime-loaded scripts (#11). Tracker removal and Google Fonts
  self-hosting (#45) are tested only against a fake Elementor site.
