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
npm run dist     # installer for the current OS (.exe on Windows, .dmg on macOS, .AppImage and .deb on Linux)
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
  (`…-arm64.dmg` for Apple Silicon, `…-x64.dmg` for Intel) and the Linux x64
  ones (`…-x86_64.AppImage`, `…-amd64.deb`, unsigned) and attaches them to it. Running the workflow by hand ("Run workflow") builds
  installers as run artifacts without releasing. Builds live in this
  workflow, not a tag-triggered one, because GitHub won't trigger workflows
  from release-please's `GITHUB_TOKEN` tags.
- Release gate: whenever release-please opens or updates the release PR
  (or on a manual dispatch, or for a PR labelled `regate`), the same run
  calls `regression.yml` on the PR's head (read from the branch ref, #111). A **patch** release
  (`scripts/release-bump.js`: same major.minor) that passes is merged by the
  workflow and released and built in that same run. A **minor/major**
  release that passes gets the `needs-approval` label and a comment, and is
  released when the maintainer merges it. A failure gets the
  `regression-failed` label and a comment, and is never merged. The gate
  only merges if `main` is still exactly what the regression run tested
  against (#97); if anything landed on `main` meanwhile it comments, labels
  the PR `regate` and leaves it to the next run (a push, the daily schedule,
  or `gh workflow run release-please.yml`), which re-gates it. This all
  happens in one run because release-please's PR updates and a
  `GITHUB_TOKEN` merge don't trigger other workflow runs.
- Public downloads and update check (#37): once `build` succeeds for a
  release, `publish-installers` copies the installers and a generated
  `latest.json` (`version`, `notes` URL, `downloads` keyed
  `<platform>-<arch>`: `win32-x64`, `darwin-arm64`, `darwin-x64`, `linux-x64`, the AppImage; the
  .deb is published alongside but not linked) to a
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
  only (the regression suite uses it). Settings › Updates turns the
  automatic check off (`autoUpdate: false`) and has "Check now", which
  always fetches and reports errors instead of staying silent.
- Code signing switches on per OS once that OS's certificate secret exists
  (repo Settings > Secrets and variables > Actions); without it the
  installer is built unsigned, as now. macOS: `CSC_LINK` (base64 of a
  Developer ID Application .p12) and `CSC_KEY_PASSWORD`, plus `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` for notarisation.
  Windows: `WIN_CSC_LINK` (base64 .pfx) and `WIN_CSC_KEY_PASSWORD`; Azure
  Trusted Signing or a cloud-HSM certificate needs extra config (#32).
- GitHub sign-in (#60) needs the OAuth App's client ID in the repository
  **variable** (not secret) `SITEBUILDER_GITHUB_CLIENT_ID`; the `build` job
  writes it into `lib/github-config.json` (gitignored). Without it the
  installers say "GitHub sign-in isn't configured". Local runs read the
  environment variable of the same name instead.

## Regression tests

`npm run test:regression` (`test/regression.js`, about 10 seconds locally)
checks the whole app end to end with no accounts, against fake sites in
`test/fakes.js`:

- single instance (`test/instance.js`): a second copy on the same data
  folder quits and the first window is restored and focused (that `focus()`
  is called; whether the OS grants focus is up to the window manager, and
  xvfb has none), while a copy on another data folder runs alongside;
- the real app, driven headlessly by `test/drive.js`: the update banner
  (from a fake `latest.json`), create a site, preview,
  edit + rebuild, theme switch, image upload, Theme Builder (new theme from
  a site's design, contrast hint, preview on that site, right-click the hero
  heading to add a rule and again to select it, edit it and see the preview
  change, Pick element + Enter, save, pick it in the Design tab), GitHub sign-in through the device flow and both ways of
  publishing that theme (push to PhaseN's private themes repo, PR to the
  public one; the suite checks only the theme's three files arrived) (theme sources point at a fake
  GitHub API with a public and a token-protected repo, so nothing reaches
  GitHub); editable WordPress import from
  a fake WordPress (REST, global styles, hostile HTML) and of a fake
  Elementor site (kit colours/font, header logo); content detection on three
  fake non-WordPress sites (landmarks, div soup, sidebar and cookie banner)
  and an editable import of the div-soup one (review in menu order, cancel,
  one page's block re-chosen in the frame, one page left out, built pages
  checked for content and no copied chrome); the ownership declaration
  (modal, main-process refusal, provenance recorded, verification file, a
  pre-#141 import asked to declare before publishing); exact copy of a fake
  Elementor site (no origin URLs left, forms re-wired, copy vs structure
  tagging, page edit, site-wide edit, image replace, undo, revert); the
  Settings page (app defaults and accounts, a per-site default override and
  Cloudflare account, then publish and take offline with Cloudflare/Resend
  stubbed in `lib/publish.js`, checking which account and values were used);
  site history (the publish tag, an edit shown as a version with its
  page-level changes, restore, no secrets or build output in any commit) and
  portable secrets; then the app is started again with a fresh userData on
  the same sites folder (a reinstall or new computer): sites found, asked
  for the passphrase, a wrong one refused, unlocked;
- the sites it made, built as publishing builds them and run under the
  bundled `wrangler dev` (on Electron's Node): pages, uploaded images, 404s,
  a theme from a theme source (downloaded from the fake GitHub API, then
  built from the site's own copy), a site built with a Theme Builder theme, the copied site's redirect, the provenance marker and `/.well-known/phasen-provenance.json` on imported sites (with no personal data anywhere in the build), and form POSTs (honeypot, validation, captcha,
  a valid message logged instead of emailed since `RESEND_API_KEY` is unset),
  and the form inbox in `wrangler dev`'s local D1 (valid messages stored with
  their email status, honeypot and Turnstile token never stored, old messages
  deleted on the next write).

It prints one line per check and a summary, and exits non-zero on any
failure. On Linux without a display it runs Electron under `xvfb-run`
(`apt install xvfb`). Set `SB_OUT=<dir>` to keep the output somewhere
fixed; otherwise it's a temp folder, named in the summary. The Worker's
Turnstile check calls Cloudflare's real siteverify endpoint with the
published always-pass test secret, so that one step needs internet access.

## How it fits together

- `main.js`: Electron main process. Stores each site in its own folder in
  the sites folder (below; `site.json` + `assets/`; uploads nothing uses any
  more are left out of published/exported sites and deleted at the next
  startup once a day old), serves the live preview through a `preview://`
  protocol, and keeps API keys encrypted (below). In this README,
  `sites/<id>/` means that site's folder.
- Sites folder, secrets and history (#136): `<Documents>/PhaseN Sites/` by
  default (Settings › Data › Change folder… moves the sites there, or points
  at a folder that already has some; the choice is in `userData/location.json`).
  One sub-folder per site, named from its name when it was made, each its
  own git repo (`lib/site-repo.js`, through
  [isomorphic-git](https://isomorphic-git.org), pure JS, MIT, so users need
  no git), plus `.phasen/` for the app's settings. On start, and with
  Settings › Data › Find sites, every sub-folder with a `site.json` and a
  `.git` is loaded (`lib/sites-folder.js` `scan`), so a reinstall or a new
  computer finds its sites. userData keeps only machine-local things:
  previews and publish builds (so they're never in a repo), caches, local
  themes and `location.json`. Edits are committed after 15 seconds without
  one, when another site opens, before publishing and on quit, with messages
  from a page-level summary ("Edited page Home; Added page Contact");
  publishing commits "Published the website" and tags it
  `live-YYYYMMDD-HHMM`. The History tab lists versions and tags, shows what
  each changed, and restores one as a new commit (`publish.json` and
  `accounts.json` are left as they are, since they describe what's live).
  **Secrets** (`lib/secrets.js`) never sit in a JSON file: every value under
  a `token`, `resendKey`, `secret`, `sendingKey` or `password` key is split
  out on write into `<site>/.secrets/secrets.enc` (per site: its accounts,
  Turnstile secret, sending key) or `.phasen/secrets.enc` (the app's
  accounts and theme-source tokens), and joined back on read. The commit
  code never stages `.secrets/` or a `secrets.enc`, whatever `.gitignore`
  says. They're encrypted with `safeStorage` by default (survives a
  reinstall on the same machine and user), or with **portable secrets**
  (Settings › Data) by a passphrase: scrypt (N=2^15) → AES-256-GCM, with the
  salt and a check value in `.phasen/portable.json` and the derived key
  remembered with `safeStorage` in `location.json`; the passphrase is never
  stored. A secrets file that can't be decrypted (another computer, damage)
  leaves those values missing, with a "re-enter" message in Settings and at
  startup, and is moved aside (`.unreadable-<time>`), never overwritten, when
  a secret is next saved. A published site whose Turnstile secret was lost
  gets a new one (`rotate_secret`) on the next publish; a lost sending key is
  re-created. Sites and settings from before #136 (`userData/sites`,
  `userData/settings.json`, each secret sealed separately) are moved on the
  first start of this version: copied, verified (file hashes), secrets
  re-encrypted, committed, renamed into place, and only then removed, so an
  interrupted move is finished by the next start; a one-time notice says
  where they went.
- `app/`: the editor UI (plain HTML/CSS/JS, no framework). `app/wordpress.js`
  is the import screen and HTML sanitizer; `app/content-detect.js` and
  `app/content-pick-frame.js` find and review the content of non-WordPress
  sites for the editable import; `app/copied.js` and
  `app/copy-edit-frame.js` edit exact-copy pages. Colours are the PhaseN
  Digital palette (tokens at the top of `app/app.css`; `--primary` is the
  darker brand green so white text on it passes WCAG AA), and
  `app/logo-wide.png` is phasen.digital's wide logo, resized with its white
  background made transparent.
- `build/icon.png`: the app/installer icon (1024x1024, just the cloud from
  phasen.digital's `logo-mark.png`, since the wordmark is illegible at icon
  sizes). electron-builder derives the `.ico`/`.icns` from it, and
  `main.js` sets it as the window icon on Linux and in dev. Brand artwork
  only ever comes from phasendigital's `public/assets/`, never its
  `website/` folder.
- Rich text sections (`richTextEditor` in `app/app.js`) use
  [Quill 2](https://quilljs.com) (BSD-3-Clause licence), an npm dependency
  loaded from `node_modules/quill/dist` (prebuilt `quill.js` and the snow
  theme CSS; electron-builder packages it, so it works offline, no build
  step). Storage stays sanitized HTML in the section's `html`: it's loaded
  into Quill, written back with `getSemanticHTML()` and passed through the
  `app/wordpress.js` sanitizer. Headings H2–H4, bold/italic/underline/strike,
  alignment (`align-*` classes, never styles), quotes, nested lists, links
  (http(s), mailto, tel or one of the site's pages, optionally styled as a
  button: `a.button`), images through the normal upload/resize pipeline
  (stored as `assets/…`, never `data:` URLs) with alt text, caption and
  position, tables, horizontal rules and YouTube/Vimeo videos. Videos are
  stored as `<div class="video-embed" data-src="…">` (YouTube rewritten to
  youtube-nocookie) and `lib/build.js` renders them as a click-to-load player:
  a `srcdoc` frame with a play link, so nothing loads from YouTube or Vimeo
  until the visitor clicks.
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
  there. Text on the main and button colours is black or white, whichever
  has the higher WCAG contrast (`contrastText` in `lib/build.js`); `npm test`
  checks every bundled theme's defaults reach 4.5:1, and the Design tab shows
  a non-blocking hint when the user's own text or main colour falls below
  that on their background. `lib/theme-validate.js` checks a package (`node lib/theme-validate.js
  themes`); an identical copy is vendored into the public
  [phasen-sitebuilder-themes](https://github.com/PhaseN-Digital/phasen-sitebuilder-themes)
  repo for its CI, so **keep the two copies in sync**: change both together
  (`cp lib/theme-validate.js ../phasen-sitebuilder-themes/scripts/theme-validate.js`,
  then a PR there; it inlines `LAYOUT_IDS`, so it needs no other file).
- Settings (`app/settings.js`, sidebar › Settings, #134): app-wide accounts
  (Cloudflare, Resend, GitHub), defaults for every website
  (form-message email, business name, message retention days and wording,
  analytics ID), theme sources, updates, data and about. A website can
  override any default where that setting appears ("Using app default (…)",
  "Override for this site", "Reset to default"; stored in
  `site.json`'s `overrides`, where a present key, even blank, is an override)
  and use its own Cloudflare/Resend accounts (Publish tab; in
  `sites/<id>/accounts.json` with the secrets in `.secrets/secrets.enc`,
  never in `site.json`).
- Documentation (#165): the sidebar's Documentation button and a link in
  Settings › About open https://sitebuilder.phasen.digital/docs in the
  browser through the https-only `open` handler. The address is `DOCS_URL`
  in `app/app.js`, its only copy.
  `lib/settings.js` is the one resolver (`resolve`, via `settingsFor` in
  main.js) that build, publish, unpublish, inbox and import use, and the one
  place settings are stored (`store()`, which splits secrets out, #136). Those JSON files are written atomically through one queue
  per file (`lib/json-store.js`), with a `.bak` copy that is read if the file
  is ever unreadable. That queue is per process, so only one copy of the app
  runs per data folder (#149): opening it again brings the existing window
  to the front instead. Publishing records the account (`accountId`, and a hash of
  the Resend key) in `publish.json`; taking offline and the inbox use that
  account, not whatever is current, and publishing to a different account
  while the site is live is refused. Older settings and sites migrate on read
  (the top-level `email` becomes `defaults.email`; a site's non-blank
  `analyticsId`, `inboxDays`, `privacy.owner`/`retention` become overrides).
- Theme sources (`lib/theme-sources.js`, Settings › Themes): extra
  themes from GitHub repos. The public
  [phasen-sitebuilder-themes](https://github.com/PhaseN-Digital/phasen-sitebuilder-themes)
  repo is always listed (it can be hidden, not removed); users add
  `owner/repo`, optionally `owner/repo/folder@branch` (default folder:
  `themes/` if present, else the repo root). Each source is downloaded as one
  tarball through the GitHub REST API (one request per refresh, so the
  unauthenticated 60/hour limit goes a long way), every theme in it is
  validated with `lib/theme-validate.js`, and the result is cached in
  `userData/theme-cache`. Private repos use a fine-grained token (Contents:
  Read-only) saved per source (encrypted, like every secret); it's only ever sent to
  api.github.com, and the download link GitHub redirects to is fetched
  without it. Choosing a theme copies it to `sites/<id>/theme/` and sets
  `site.themeSource`, so builds and publishes never need the repo or the
  cache; "Update theme" downloads the source again and replaces the copy
  (colours and font stay as the user set them).
- Theme Builder (`lib/theme-builder.js`, `app/theme-builder.js`, sidebar ›
  Themes…, #130): makes theme packages from controls (colours, font, corner
  radius, header/button/link style, section spacing, plus Advanced CSS) and
  keeps them in `userData/themes-local/<id>/`, apart from any website. The
  controls are stored as the first-line comment of `theme.css`, so a package
  stays in the plain #57 format. Every save is validated with
  `lib/theme-validate.js` (nothing is replaced if it fails) and bumps the
  patch version; `preview.png` is the sample preview captured in a hidden
  1280x800 window and scaled to 640x400. The live preview builds built-in
  sample content (or one of the user's sites) as a hidden pseudo-site
  (`sites/00000000-0000-4000-8000-000000000000`, no `site.json`, so never
  listed) served through `preview://`. Contrast hints use `lib/build.js`'s
  `contrastRatio`. Local themes show in the Design tab as the `local` theme
  source ("Your themes"); choosing one copies it to `sites/<id>/theme/` like
  any source theme. "New theme from a website's design" starts from the
  site's colours, font and theme (a builder theme's controls, or another
  theme's CSS as Advanced CSS; exact copies: colours and font only).
  Right-clicking (or Alt+clicking) the preview, or "Pick element" then the
  arrow keys and Enter, opens a menu (#156) to add or select the element's
  rule in Advanced CSS, choose a broader selector, or see its current styles.
  `app/theme-builder-frame.js` is injected into the preview (`?sb-theme`) and
  reports over postMessage; the menu is drawn by the builder. Selectors use
  only the classes and landmarks `lib/build.js` generates (the script's `STABLE`,
  checked against built output by test.js); rules are found and added by
  `cssRule` in `lib/theme-builder.js`, which splits top-level rules
  properly (comments, strings, `@media` blocks).
  Each valid theme in the list can be published to GitHub (#60):
- GitHub sign-in and theme publishing (`lib/github.js`, Settings › Accounts,
  Themes… › "Push to repo…"/"Submit to public repo…", #60). Sign-in is the
  OAuth device flow (the app shows a code, the user approves it on
  github.com; no client secret), scope `public_repo`, plus `repo` when
  "Also allow private repositories" is ticked. The token is app-wide,
  in `settings.github` (the token itself in `.phasen/secrets.enc`, #136), and also used for theme sources that
  have no token of their own. Publishing validates the theme with
  `lib/theme-validate.js` and sends only `theme.json`, `theme.css` and
  `preview.png`, as one commit through the git data API. "Push to repo"
  commits to `themes/<id>/` (or `owner/repo/folder@branch`) of any repo the
  user can write to, defaulting to the last one used, else
  PhaseN-Digital/phasen-themes-private when the user can write to it.
  "Submit to public repo" forks phasen-sitebuilder-themes (GitHub reuses an
  existing fork), syncs the fork, commits on a new branch and opens a PR
  titled with the theme's name, its description as the body; the themes
  repo's CI and PhaseN's review do the rest.

## Privacy page

Sites with a form (built-in or copied) get a generated, `noindex` privacy
notice at `/privacy` (`renderPrivacy` in `lib/build.js`), linked from the
footer of built pages. It names the business, the contact email (the first
used form's "Send messages to", else the form-message email from Settings or
the site's override), what each form
collects, Cloudflare/Turnstile and Resend as processors, how long messages
are kept (by default, the Inbox's "Delete messages after" days) and the
visitor's UK GDPR rights. The business name and retention
sentence are defaults in Settings, overridable in Publish › Privacy page, which says it's a starting point,
not legal advice. Exact-copy pages keep their own footer, so there the user
is told the address and adds the link themselves; the notice doesn't cover
third-party services the copied pages load.

## Analytics and cookie consent

Design › Google Analytics measurement ID (optional, a Settings default the
site can override, `overrides.analyticsId`, must
look like `G-XXXX`, anything else is ignored). When set, every page built
from the site's own themes gets a cookie banner and `runtime/consent.js`
(copied to `/consent.js`, ID passed in `data-ga-id`). Following UK PECR, the
Google tag only loads after the visitor clicks Accept; the choice is kept in
`localStorage` and a footer "Cookie preferences" link reopens the banner.
Nothing loads in the in-app preview. The site then always gets the privacy
page, which gains an "Analytics and cookies" section (and drops the form
parts if there are no forms). Exact-copy pages don't get the banner (#45).

## Page layouts (#169)

Every page built from the themes has a layout (`page.layout`), defined once
in `lib/layouts.js` (id, label, description, the sections "Add page" seeds,
the extra fields it adds, and the chooser's wireframe thumbnail, a small
static SVG so it needs no rendering per theme). `lib/build.js` requires it and
`app/index.html` loads it as a plain script. Sites saved before layouts are
migrated when read (`migrateLayouts` in main.js's `readSite`): the first page
becomes Home, the rest Standard; copied pages have none.

| Layout | Seeds | Build adds |
|---|---|---|
| Home | banner, cards, text & image, review cards, closing banner | nothing (the banner is the title) |
| Standard | text | a title band |
| Landing | banner, cards, form | no menu |
| Services | intro, cards | a title band |
| Contact | form, details, "find us" | a title band; forms beside text, two columns |
| Blog post | rich text | article header: title, date, author; featured image |
| Blog | nothing | the post list |
| Legal | rich text | a title band, narrow column (the generated privacy page uses it) |

Pages › "+ Add page" asks for the layout; Pages › Layout changes it later and
keeps the sections. The page is `<body class="layout-<id>">`; only its
first heading is an `h1` (the title band, else the first banner, later
banners get `h2`), and the title band is left out when a banner opens the
page. Rich text sections can be "shown as cards": each Heading 3 starts a
card. Blog post pages have `date` (YYYY-MM-DD), `author`, `featuredImage` and
`excerpt` (else the start of the first text). A Blog page lists them newest
first (undated last), ten to a page, at `<blog>/page/2/` and so on, all in the
sitemap with their own canonical; with a Blog page, posts leave the menu.
`base.css` styles every layout, and each bundled theme restyles them with
`.layout-<id>` rules; a theme without any still looks right. A theme package
may add `"layouts": { "<id>": { "notes": "…" } }` to theme.json, and
`lib/theme-validate.js` rejects unknown layout ids there and in theme.css's
`.layout-<id>` selectors (its own `LAYOUT_IDS` list, kept equal to
`lib/layouts.js` by `npm test`).

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
The import log warns that search engines are blocked only when robots.txt
disallows `/` for `*`, Googlebot or Bingbot; agents blocked in their own
groups (GPTBot, CCBot) are reported neutrally as kept AI crawler blocks (#167).

## Importing a website

"Import a website…" takes any address, and any site can come in editable or
as an exact copy. "Decide for me" picks an exact copy when the home page shows
a page builder (Elementor, Divi, Beaver Builder, WPBakery, Bricks, Oxygen,
Avada; detected from the builder's own markup), when a WordPress site's REST
API can't be read (including one hidden from visitors when no username and
application password were given), or when the address isn't a WordPress site
and the content of most pages can't be told apart from their design; the
editable import otherwise.

### Ownership declaration and provenance (#141)

Every import first shows a modal warning that copying a site you don't own or
have permission to copy can infringe copyright, trademarks and database
rights, with a required checkbox ("I confirm I own this website, or have the
owner's written permission to copy and republish it"); Import stays disabled
until it's ticked. main.js refuses `wp:fetch` and `wp:mirror` without that
declaration too, so a UI bug can't skip it. The wording is not legal advice
and is to be reviewed alongside the privacy page (#30).

The site records `importProvenance` in site.json: source origin,
`importedAt`/`declaredAt`, app version, `declaredBy` (name and email from
Settings), the statement ticked, and `verification`. Verification is
attempted at import and recorded, never required (`verifyOwnership` in
`lib/mirror.js`): verified if the source's domain is a zone in the connected
Cloudflare account, if a WordPress import's application password was accepted
(`/wp/v2/users/me`; kept when "Decide for me" then falls back to an exact
copy of that site, #145), or if the source serves `/phasen-verify-<token>.txt`
containing the random token shown in the modal.

`build()` (`stampProvenance` in `lib/build.js`) adds
`<meta name="generator" content="PhaseN Site Builder">`,
`<meta name="phasen:imported-from" content="<source origin>">` and
`<meta name="phasen:imported-on" content="YYYY-MM-DD">` to every built page,
theme-built and copied (replacing a copied page's own generator tag), and
writes `/.well-known/phasen-provenance.json` (source, date, app version,
verification). Nothing personal is published: `declaredBy` stays in
site.json. The modal and the Publish tab tell the user about the marker.
The in-app preview shows the same meta tags on copied pages (`stampHtml`,
applied as main.js serves them; the files on disk stay unmarked).

Sites imported before this (an exact copy, or pages with a `path`) have no
declaration: they're asked for one (with the source address) once per
session when opened, the Publish tab explains why and offers it again, and
`publish()` and "Save as package…" (`sites:export`) refuse until it's given
(`requireProvenance` in main.js, #145), so the package always carries the
marker too.

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
address, `mailto:`, `tel:` or a copied page's path. Clicking an image inside
a link (e.g. a logo) shows the same Link panel under the Image panel.
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
- Pages that contained a WordPress enquiry form (Contact Form 7 etc.) get
  the built-in contact form instead. Log-in, cart, checkout and search forms
  are never swapped for it.
- Pages that only work on WordPress (WooCommerce cart, checkout and my
  account; log-in, register and lost-password; membership account pages)
  are skipped and listed in the import log. They're recognised by slug or
  title, WooCommerce/membership-plugin shortcodes and markup, or a log-in or
  shop form with no enquiry form beside it (`classifyPage` in
  `lib/wordpress.js`, using the same form rules as the exact copy).
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

### Editable import of any other website (#161)

When the address isn't a WordPress site, the site is first copied exactly
(`lib/mirror.js`, with the same declaration and provenance), then
`app/content-detect.js` works on the copied pages:

- Shared chrome (`sharedChrome`): container blocks near the top of the page
  (header, nav, footer, aside, div, section, list, dialog, form) whose tag,
  classes, text and images are identical on at least 60% of pages. That's the
  header, menu, footer, sidebar and cookie banner; the theme has its own.
- Content (`mainContent`): a `<main>`/`[role=main]` (or a lone `<article>`)
  outside the chrome, with high confidence; otherwise Mozilla Readability
  (`@mozilla/readability`, Apache-2.0, loaded by `app/index.html` from
  `node_modules` like Quill) run on a copy without the chrome, mapped back to
  the tightest block around the text it kept. Medium confidence with real text,
  low otherwise. The result is a CSS path (`body > div:nth-child(2) > …`).
- Review step: each page in menu order (home first, then the menu's order,
  then the rest), with its preview (`?sb-pick`: main.js injects
  `app/content-pick-frame.js` and blocks the page's own scripts with a nonce
  CSP, so the frame shows exactly the HTML being imported) and the detected
  content outlined. Clicking another block (or "Choose the block around it")
  picks it; unticking a page leaves it out. "Keep an exact copy" stops there.
  Cancel deletes the copy.
- Import (`toSections`, `rebuildEditable`): each page's content, minus any
  chrome, menus and pop-ups inside it, becomes a "Rich text" section (one per
  `<section>` if that's all it holds) through the same sanitizer, image
  download and link rewriting as WordPress; pages keep their old address
  (`page.path`, `.html` addresses get a 301). An enquiry form in the content
  becomes a form section with the copied fields (checkbox groups become text
  answers); forms in the chrome are dropped. The logo is a "logo"-named (else
  the first) image in the chrome; colours and font are the home page's
  computed styles (body background and text, link colour, button colour),
  mapped to the closest built-in theme as for WordPress. The copied files are
  then deleted (`mirror:discard`).

## What publishing does

1. Uses the workers.dev subdomain, or the chosen Cloudflare zone (plus an
   optional subdomain such as `shop`, giving `shop.<zone>`, #135) as a Custom
   Domain. The site stores this as `domain: { zoneId, zoneName, label }`
   (`label` empty for the apex); sites saved as `{ id, name }` are migrated
   when read. Labels must be DNS-safe (lowercase letters, digits and hyphens,
   dots between parts, each at most 63 characters). Before publishing, the
   Publish tab and the log warn, without blocking, if the hostname already
   has DNS records or is attached to a different Worker.
2. Creates/updates a Turnstile widget for that hostname.
3. With a custom domain: registers the zone apex with Resend (a subdomain
   site still sends from `website@<zone>`) and writes Resend's DNS
   records into the zone (scoped to `send.<domain>`, so existing mailboxes are
   untouched). Without one, forms send from `onboarding@resend.dev`, which
   Resend only delivers to the Resend account owner's email.
4. Creates a sending-only Resend key for the site's Worker.
5. Creates (or reuses) the site's form inbox, a D1 database named
   `<worker>-inbox`, with its `messages` table, and binds it to the Worker as
   `DB`. If the token lacks D1 permission, publishing carries on without it
   (forms only email) and the log says so.
6. `wrangler deploy`, then `wrangler secret bulk` for the Turnstile secret and
   Resend key.
7. With a custom domain on the zone apex (not for a subdomain): a proxied `www` CNAME and a 301 Single Redirect rule
   (`http_request_dynamic_redirect` phase) sending `www.<domain>` to the apex,
   as phasen.digital's Terraform does. An existing `www` record or existing
   redirect rules are left alone (logged, not overwritten). If this step fails,
   e.g. the token lacks the permission, publishing still succeeds and the log
   says why.

The Cloudflare token needs the "Edit Cloudflare Workers" template plus
Account › Turnstile › Edit, Account › D1 › Edit, Zone › DNS › Edit and Zone › Single Redirect ›
Edit (Dynamic Redirect on some accounts, needed for the `www` redirect). The app lists these steps
in Settings and in the Publish tab's "Override for this site".

## Form inbox

Every valid form message is also stored in the site's D1 database (#75) by
`runtime/worker.js`, before it's emailed: the form id, the fields as JSON
(`[{ label, value }]`), `created_at` (UTC) and `email_status` (`sent`,
`failed (<HTTP status>)`, `not sent (no email key)`, or `pending` if the
Worker stopped mid-send). The honeypot and Turnstile token are never stored.
If the email fails but the message was stored, the visitor is told it was
sent, since it's waiting in the Inbox. A database error never stops the
email.

The app's Inbox tab lists, reads, deletes and exports (CSV) messages through
Cloudflare's D1 query API with the user's own token (`inbox:*` in main.js),
so no public endpoint serves them. Messages that weren't emailed get a
warning badge. Retention is the site's "Delete messages after" setting
(a Settings default the site can override, `overrides.inboxDays`, default 90): built into the Worker as `RETENTION_DAYS`,
which deletes older messages on every write, applied again whenever the app
lists the inbox, and quoted in the privacy page's default retention
sentence. Exported packages ("Save as package…") include the D1 binding only
once the site has been published.

## Taking a site offline

"Take website offline" in the Publish tab, or ticking "Also take it offline"
when deleting a site, undoes publishing (`unpublish` in `lib/publish.js`),
using what `sites/<id>/publish.json` recorded at publish time:

1. Deletes the Worker and its Custom Domains.
2. Deletes the `www` record and redirect rule, but only ones publishing made
   (matched by the record's comment and the rule's `ref`).
3. Deletes the Turnstile widget, the form inbox's D1 database (with its
   messages; the confirmation says to export them first) and the site's
   Resend sending key.

Each step is logged and best-effort: one failing doesn't stop the rest, and
anything already gone (404) counts as removed. Whatever failed stays in
`publish.json` so trying again only retries that, and a delete keeps the
site's local files until taking it offline has fully worked.

## Known gaps

- Linux (#153): x64 only (no arm64 build), unsigned, and checked only
  headlessly (the AppImage's window opening under xvfb, its bundled wrangler's
  `deploy --dry-run`, `dpkg-deb -I` on the .deb), not yet installed and used
  on a real Linux desktop. The update banner links the AppImage; .deb users
  update by downloading the new .deb themselves.
- Form inbox (#75): the D1 API calls (create, query, delete) are tested only
  against a stubbed API in test.js, and the Worker's storage only under
  `wrangler dev`'s local D1, not yet against real Cloudflare. A changed
  "Delete messages after" value reaches the Worker only on the next publish.
  The Inbox loads every message at once.
- Rich text (#120): Quill has no header cells or line breaks inside a
  paragraph, so imported `<th>`s become ordinary cells and `<br>` starts a
  new paragraph; a quote with several paragraphs becomes several quotes, and
  image captions are plain text (links in them are lost). The text itself is
  always kept. Videos can't play in the in-app preview (YouTube refuses
  players without an http(s) referrer); they play on the published site.
  Vimeo's player was only checked to load in Electron, not played in a real
  browser.
- Subdomains (#135): moving a published site from the apex to a subdomain
  (or between hostnames) doesn't remove its old www redirect or old Custom
  Domain until it's taken offline (#139). The hostname warnings and the
  Custom Domain on a subdomain are only tested against a stubbed Cloudflare
  API, not the real one.
- Taking a site offline (#71) leaves the domain registered with Resend and
  Resend's DNS records in the zone, since they may predate the app or be
  shared. Sites published before 0.5 didn't record their Resend key's id, so
  that key has to be deleted at resend.com by hand (the log says so). Only
  tested against a fake Cloudflare/Resend API so far, not the real ones.
- Release gate: GitHub's merge API can't require an unchanged base, so a
  push to `main` in the second between the gate's last check and its merge
  still lands under the squash. The gate catches it and doesn't release from
  that run, but the next run would (#99).

- Settings (#134): per-site accounts and overrides are tested against a
  stubbed Cloudflare/Resend in the regression suite, not real accounts, and
  only on Linux. Moving a live site to another Cloudflare account means taking
  it offline first. Backup/restore (#70), diagnostics (#86) are disabled
  placeholders.
- Sites folder and history (#136): tested on Linux only (unit tests, and the
  regression suite with `safeStorage` in its plain-text mode), not yet on
  Windows/macOS keychains or with a synced folder (OneDrive/iCloud). Site
  folders keep the name they were made with when a site is renamed. A lost
  sending key is re-created without deleting the old one at Resend. A secrets
  problem for a deleted site's folder shows until the app restarts. Nothing
  is pushed anywhere yet (the repos are local), and the 100MB GitHub warning
  only lists files in the History tab. Restoring a version doesn't restore
  the site's accounts or publish state, by design.
- Theme sources: a public-repo theme with the same id as a built-in one is
  hidden (the built-in wins), so built-in themes can't be updated from the
  repo. Sources are only downloaded when first listed, on "Refresh" and on
  "Update theme"; there's no automatic check for newer versions. Tested
  against a fake GitHub API and the real public repo, not yet with a real
  private repo and token.
- Theme Builder (#130): only themes it made can be edited (a hand-written
  local theme can be used and deleted, not edited). Editing a local theme
  doesn't change websites already using it until they press "Update theme".
  `preview.png` capture is tested headlessly on Linux only; if capture fails
  the theme is saved without one. The right-click menu (#156) only finds a
  rule whose selector matches exactly (not one inside a selector list or
  `@media`).
- GitHub publishing (#60): tested against a fake GitHub API only (device
  flow, git data API, fork, PR), not yet the real one. Signing out only
  forgets the token; revoking it is done on GitHub (the app has no client
  secret to revoke it with). A file dropped from a theme (an old
  `preview.png`) stays in the target repo, since a push only adds or
  replaces files.

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
- Import provenance (#141): the declaring user's name comes from
  `settings.name`, which nothing sets until the Settings page (#134) adds it,
  so only the email is recorded for now. Verification by Cloudflare zone and
  by application password is tested against fakes only; the verification
  file also end to end against the fake WordPress. The application-password
  result is remembered per origin in memory only, so it's lost if the app
  restarts between connecting and the exact-copy fallback.
- Editable import of other sites (#161): tested only against fake sites, not
  yet real ones. Chrome detection needs blocks to match exactly, so a menu
  that marks the current page in its text, or a single-page site, keeps it
  inside the content unless it's a `<nav>`. Only content in the HTML is seen
  (nothing a script adds), headings made of styled `<div>`s come in as plain
  text, and lazy-loaded images with no `src` are dropped. Links to an address
  the crawl saw redirect keep pointing at the old site. The review frame's
  colours come from the home page only.
- Imports have been tried against a handful of public WordPress sites
  (Elementor, Divi, block theme, classic theme with the REST API hidden) and
  one Elementor 4 site of the maintainer's own (both imports, with an
  application password), but not yet against a client site. Known problems
  from that: conditional-field detection in re-wired forms is built from
  plugin markup conventions, not yet re-tested on a real Gravity, Fluent or
  Divi conditional form (#22); editable import of Divi/WPBakery pages, block-theme home pages and SVG logos (#24);
  Elementor 3 runtime-loaded scripts (#11). Tracker removal and Google Fonts
  self-hosting (#45) are tested only against a fake Elementor site.
