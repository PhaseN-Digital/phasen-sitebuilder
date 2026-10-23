# PhaseN Site Builder

Desktop app (Windows/macOS) for building small business websites and publishing
them to Cloudflare, with no command line. Each site it produces has the same
shape as phasen.digital: a single Cloudflare Worker serving static assets plus a
form API (`POST /api/forms/<id>`) with honeypot, Turnstile and Resend email.

```
npm install
npm start        # run the app
npm test         # builder self-check
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
- `release-please.yml`: maintains a release PR (version bump in
  `package.json`, `CHANGELOG.md`). Merging it creates the GitHub release, and
  the `build` job then builds the Windows and macOS installers and attaches
  them to it. Running the workflow by hand ("Run workflow") builds
  installers as run artifacts without releasing. Builds live in this
  workflow, not a tag-triggered one, because GitHub won't trigger workflows
  from release-please's `GITHUB_TOKEN` tags.

## How it fits together

- `main.js`: Electron main process. Stores sites under the app's user-data
  folder (`sites/<id>/site.json` + `assets/`), serves the live preview through a
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

## Importing from WordPress

"Import from WordPress…" offers two kinds of import. "Decide for me" picks an
exact copy when the home page shows a page builder (Elementor, Divi, Beaver
Builder, WPBakery, Bricks, Oxygen, Avada; detected from the builder's own
markup) or there's no REST API (including one hidden from visitors when no
username and application password were given), and the editable import
otherwise.

### Exact copy (`lib/mirror.js`)

Crawls the rendered site from `/` (same-site links only, up to 500 pages and
5,000 files) and saves each page's HTML plus every same-site CSS, JS, font
and image at its original path under `sites/<id>/mirror/`. Since paths are
kept, the only rewrite needed is stripping the site's domain from URLs
(including JSON-escaped ones in inline scripts), so links, CSS `url()`s and
srcsets keep working. Redirects found while crawling go into Cloudflare's
`_redirects` file, and WordPress's own 404 page is copied (with its own
stylesheets and images).

POST forms are re-wired in place, keeping their markup and styling: the
questions are read from the form's fields, and the form gets a `data-form`
id, honeypot and Turnstile widget. The same form on many pages (a footer
newsletter form) becomes one form. Log-in forms (anything with a password
field) are left alone. `runtime/form.js` listens in the capture
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
There's no undo yet: re-import to start over.

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
  (block themes; WordPress's own default button colour is ignored). Classic
  themes and page builders mostly don't expose these, so they get a built-in
  theme's defaults.
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

The Cloudflare token needs the "Edit Cloudflare Workers" template plus
Account › Turnstile › Edit and Zone › DNS › Edit. The app lists these steps
in the Publish tab.

## Known gaps

- Installers are unsigned: Windows SmartScreen and macOS Gatekeeper will warn.
  Add signing (Apple Developer ID + notarisation, a Windows code-signing
  certificate) before giving the app to clients.
- The macOS build is Apple Silicon only (`macos-latest`). Add an Intel runner
  to the matrix if needed.
- `asar` is off and workerd (only used by `wrangler dev`) is bundled because
  wrangler loads it at startup, so installs are about 600 MB unpacked.
- No `www` → apex redirect, analytics/cookie banner, privacy page, or
  removal of unused uploaded images.
- Imports have been tried against a handful of public WordPress sites
  (Elementor, Divi, block theme, classic theme with the REST API hidden), but
  not yet against a real client site. Known problems from that: re-wired forms
  with conditional or checkbox-group fields, and cart/comment forms (#22);
  WordPress installed in a subfolder (#23); editable import of Divi/WPBakery
  pages, block-theme home pages and SVG logos (#24).
