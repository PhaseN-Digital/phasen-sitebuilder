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

Installers for both platforms: run the `build` workflow (Actions tab), or push a
`v*` tag.

## How it fits together

- `main.js`: Electron main process. Stores sites under the app's user-data
  folder (`sites/<id>/site.json` + `assets/`), serves the live preview through a
  `preview://` protocol, and holds API keys encrypted with the OS keychain
  (`safeStorage`).
- `app/`: the editor UI (plain HTML/CSS/JS, no framework).
- `lib/build.js`: `site.json` → `public/`, `worker/`, `wrangler.toml`. The
  preview, publish and "Save as package" all use it.
- `lib/publish.js`: Cloudflare and Resend API calls, plus the bundled
  wrangler. Wrangler runs on Electron's own Node via `ELECTRON_RUN_AS_NODE`, so
  users install nothing else. `lib/wrangler-argv-fix.js` is required for that
  to work, see the comment in it.
- `runtime/`: the form Worker and browser script copied into every site.
- `themes/`: `base.css` plus one small override file per theme. Colours/fonts
  are CSS variables the user picks in the Design tab.

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
