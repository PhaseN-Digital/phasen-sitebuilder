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

Installers for both platforms are attached to each GitHub release, see
"Commits and releases".

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
(`.githooks/`) that checks this locally; CI checks every commit in a PR. Both
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

- the real app, driven headlessly by `test/drive.js`: create a site, preview,
  edit + rebuild, theme switch, image upload; editable WordPress import from
  a fake WordPress (REST, global styles, hostile HTML); exact copy of a fake
  Elementor site (no origin URLs left, forms re-wired, copy vs structure
  tagging, page edit, site-wide edit, image replace, undo, revert);
- the sites it made, built as publishing builds them and run under the
  bundled `wrangler dev` (on Electron's Node): pages, uploaded images, 404s,
  the copied site's redirect, and form POSTs (honeypot, validation, captcha,
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
- `themes/`: `base.css` plus one small override file per theme. Colours/fonts
  are CSS variables the user picks in the Design tab.

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

## Importing from WordPress

"Import from WordPress…" offers two kinds of import. "Decide for me" picks an
exact copy when the home page shows a page builder (Elementor, Divi, Beaver
Builder, WPBakery, Bricks, Oxygen, Avada) or there's no REST API, and the
editable import otherwise.

### Exact copy (`lib/mirror.js`)

Crawls the rendered site from `/` (same-site links only, up to 500 pages and
5,000 files) and saves each page's HTML plus every same-site CSS, JS, font
and image at its original path under `sites/<id>/mirror/`. Since paths are
kept, the only rewrite needed is stripping the site's domain from URLs
(including JSON-escaped ones in inline scripts), so links, CSS `url()`s and
srcsets keep working. Redirects found while crawling go into Cloudflare's
`_redirects` file, and WordPress's own 404 page is copied.

POST forms are re-wired in place, keeping their markup and styling: the
questions are read from the form's fields, and the form gets a `data-form`
id, honeypot and Turnstile widget. `runtime/form.js` listens in the capture
phase so the page builder's own submit handler (which would post to
WordPress) never runs. Turnstile key and thank-you message are filled in at
build time.

Copied pages are edited in place in the preview (Pages tab). `app/copied.js`
separates copy from theme structure once, right after import: it tags text
blocks (headings, paragraphs, list items, button text, page-builder text
widgets) and images with a `data-sb-edit` key. Anything inside the header,
menu, footer or sidebar (landmarks plus Elementor/Divi/Beaver/theme
conventions) gets a site-wide `s-` key derived from its original text, so the
same menu item or logo matches on every page and an edit there is applied to
all of them. Everything else gets a per-page `p-` key. Layout elements are
never tagged. `app/copy-edit-frame.js` is injected into the preview to make
tagged elements editable. Edits are written into the stored HTML (not the
live DOM, which page scripts have modified), and the build strips the tags.
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
only needed if the site blocks public REST access. They're only sent over
https and aren't stored.

- Content: every published page becomes a page with a "Rich text" section.
  `lib/wordpress.js` fetches; `app/wordpress.js` sanitizes with an allowlist
  (scripts, iframes, forms, inline styles/handlers and `javascript:` links
  are removed). Images are downloaded and re-encoded like uploads. Links
  between imported pages are rewritten to the new pages; other links (posts,
  files) keep pointing at the old site.
- Pages that contained a WordPress form (Contact Form 7 etc.) get the
  built-in contact form instead.
- "Theme": WordPress themes are PHP, so only the name, tagline, logo,
  colours and font style are copied, from the home page's global styles
  (block themes). Classic themes mostly don't expose these, so they get a
  built-in theme's defaults.
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

- Installers are unsigned until the signing secrets are added (see "Commits
  and releases"): Windows SmartScreen and macOS Gatekeeper will warn. Signing
  is wired up but untested, since no certificates exist yet (#6).
- `asar` is off and workerd (only used by `wrangler dev`) is bundled because
  wrangler loads it at startup, so installs are about 600 MB unpacked.
- No analytics/cookie banner.
