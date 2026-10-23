# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PhaseN Site Builder: an Electron desktop app (Windows/macOS) that lets
non-technical users build small websites, import WordPress sites, and publish
them to Cloudflare Workers with working forms. README.md covers the
architecture, the WordPress imports, what publishing does, and the release
process. Read it before changing anything substantial.

## Commands

```
npm install      # also points git at .githooks (commit-msg check)
npm start        # run the app
npm test         # builder/form-parser self-check + syntax check of every script
npm run test:regression  # end-to-end: real app under xvfb + built sites under wrangler dev
npm run dist     # installer for the current OS
```

`npm test` doesn't cover the editor UI or the Electron main process;
`npm run test:regression` does (README "Regression tests"). When a change
alters a flow it covers, extend `test/drive.js` (UI, via `executeJavaScript`)
or `test/regression.js` (built site under `wrangler dev`), and the fakes in
`test/fakes.js` if needed. For anything else in the UI, launch the app and
exercise it (headlessly with `xvfb-run` and `executeJavaScript`).

## Tracking work: required for every change

All work is tracked in the GitHub Project **PhaseN Site Builder**
(https://github.com/orgs/PhaseN-Digital/projects/3), backed by issues in
this repo. The project's Priority field (P0 urgent / P1 next / P2 later) is
the roadmap.

1. **Before starting**, find the issue for the work
   (`gh issue list -R PhaseN-Digital/phasen-sitebuilder --search "<words>"`).
   If none exists, create one (label `bug`, `enhancement` or `task`) and add
   it to the project. Don't start untracked work, however small.
2. **Move it to In Progress** when work starts, **Testing** once the change
   is in a PR awaiting review or merged but not yet verified in the real app
   or against real services, and **Done** once merged and verified. Closing the issue (via
   `Closes #n` in the PR) is not enough on its own; also set Status.
3. **Reference the issue** in commits (`fix(publish): retry DNS (#12)`) and
   put `Closes #n` in the PR description.
4. **Anything found but not fixed** (bugs, limitations, follow-ups,
   untested paths) becomes a new issue with a priority, rather than only a
   mention in a reply or a code comment. When a README "Known gaps" item is
   fixed, update the README too.
5. Report honestly in the issue: if something was only tested against fakes
   or not on Windows/macOS, say so and leave it in Testing.

Commands (IDs are for project 3; re-fetch with
`gh project field-list 3 --owner PhaseN-Digital --format json` if one stops
working):

```
# add an issue to the project (prints the item id)
gh project item-add 3 --owner PhaseN-Digital --url <issue-url> --format json

# find an issue's item id
gh project item-list 3 --owner PhaseN-Digital --format json --limit 200

# set Status / Priority
gh project item-edit --project-id PVT_kwDOEGZ8sM4BodIk --id <item-id> \
  --field-id PVTSSF_lADOEGZ8sM4BodIkzhm9L7M --single-select-option-id <status>
#   Todo f75ad846 · In Progress 47fc9ee4 · Testing 6f895a27 · Done 98236657
gh project item-edit --project-id PVT_kwDOEGZ8sM4BodIk --id <item-id> \
  --field-id PVTSSF_lADOEGZ8sM4BodIkzhm9L_w --single-select-option-id <priority>
#   P0 70fd2ac7 · P1 7e44daaa · P2 fc0b4a31
# Target date (for the Roadmap view): --field-id PVTF_lADOEGZ8sM4BodIkzhm9MCI --date YYYY-MM-DD
```

`gh project item-list` can lag behind `item-add` by a while. To confirm an
issue is on the project, check
`gh issue view <n> --json projectItems`.

Issues filed through the bug/feature forms (`.github/ISSUE_TEMPLATE/`) are
added to the project automatically. Issues created with `gh issue create`
are not, so add them yourself.

## Commits, CI and releases

- **Never commit directly to `main`.** Work on a branch named after the
  change type (`feat/…`, `fix/…`, `chore/…`), push it, and open a PR with
  `Closes #n`. Changes reach `main` only by merging a PR, which is what
  CI and release-please run on. The `pre-commit` hook refuses commits on
  `main`. The same applies to release-please's own release PR: merge it, don't
  push version bumps by hand.
- **Every change needs the maintainer's review.** Open the PR, wait for CI,
  move the issue to Testing, and stop. Never merge a PR yourself, including
  release-please's, unless you are the `release-manager` agent and the
  maintainer has authorised merging for the current session.
- **Agents** (`.claude/agents/`): when working through issues, run one fresh
  `issue-worker` per issue (it implements, tests and opens a PR, but never
  merges) and hand ready PRs to the `release-manager`. The release manager
  is the only thing that merges, one PR at a time and in dependency order,
  each brought up to date with `main` and green in CI first, and it says which
  issues are safe to start next. Workers declare `Depends on #n` and
  `Files:` in their PR bodies. GitHub can't enforce any of this yet
  (branch protection needs a paid plan for this private repo, see #5).
- Commit messages must be Conventional Commits (`feat:`, `fix(scope):`,
  `feat!:` …). The `commit-msg` hook and CI's `commits` job both run
  `scripts/check-commit.js`. release-please silently skips anything else,
  dropping it from the changelog and version bump. Don't bypass the hook with
  `--no-verify`.
- `ci.yml` runs `npm test` on PRs and pushes to `main`.
- `regression.yml` runs `npm run test:regression` on release-please PRs
  (`release-please--` branches), on "Run workflow" and via `workflow_call`.
- `release-please.yml` keeps a release PR open. Merging it creates the GitHub
  release, and its `build` job builds and attaches the Windows/macOS
  installers. Builds deliberately live in that workflow, not an
  `on: release`/tag workflow: release-please's GITHUB_TOKEN tags can't
  trigger other workflows, so a separate one would never run.
- Installers must be built on each OS (platform-specific esbuild/workerd
  binaries), which is why `build` is a matrix. The same goes for CPU arch:
  the Intel dmg comes from an Intel runner (`macos-15-intel`), not an arm one.
- `package.json`'s `allowScripts` approves the dependency install scripts
  those binaries need (esbuild, workerd, electron-winstaller, fsevents on
  macOS). Newer npm blocks unapproved install scripts, which would ship
  installers without working binaries. If `npm ci` warns about a package
  "not yet covered by allowScripts", review it and run
  `npm install-scripts approve --no-allow-scripts-pin <pkg>` (or `deny`).

## Things that are easy to break

- Wrangler runs on Electron's own Node (`ELECTRON_RUN_AS_NODE`) and needs
  `lib/wrangler-argv-fix.js` preloaded. Without it, yargs misreads argv
  under Electron. That's also why signed macOS builds rely on
  electron-builder's defaults: hardened runtime with its stock entitlements
  (allow-jit, allow-unsigned-executable-memory, disable-library-validation),
  which the self-spawned Node also needs, and the RunAsNode fuse left on.
  Don't add `electronFuses.runAsNode: false` or a narrower entitlements file.
- Signing in `release-please.yml`'s `build` job is driven by secrets that
  may be absent. Empty secrets must be unset before `npm run dist`
  (electron-builder treats an empty `CSC_LINK` as set, and Windows falls back
  to `CSC_LINK`), as the "Build installer" step does.
- Generated sites follow phasen.digital's shape: non-asset requests must
  fall through to `env.ASSETS.fetch` (`runtime/worker.js`), or custom 404
  pages break.
- Copied (exact-copy) pages are edited in their stored HTML via
  `data-sb-edit` keys (`app/copied.js`). `s-` keys are site-wide and derived
  from the element's original text, so don't change how keys are computed
  without migrating existing sites. Every write to a copied page goes
  through `mirror:keep-original` first and pushes onto the undo stack
  (`applyCopyEdit`), or undo/revert will miss it.
- `pagePaths` in `lib/build.js` always reserves the generated privacy page's
  slug and returns it under the `privacy` key (page ids are hex, so it can't
  clash); `build()` drops it when the site has no forms and no valid
  analytics ID, and the editor uses
  `paths.privacy` to decide whether to show the Privacy page settings.
- With `site.analyticsId` set, the Google tag must only ever be injected by
  `runtime/consent.js` after Accept (UK PECR); never add `gtag.js` to a page
  head. `test.js` asserts no built page mentions it.
- Anything WordPress-imported is untrusted: editable imports go through the
  allowlist sanitizer in `app/wordpress.js`, and copied-page edits through
  `cleanEdit` in `app/copied.js`.
- Uploaded images are found by `usedAssets` (`lib/build.js`) searching
  site.json and the `mirror`/`mirror-original` HTML for `assets/<name>`. A
  new place that stores an image reference must be covered there, or
  publishing drops the image and startup deletes it. Never prune while the
  editor is running: copied-page undo history lives in its memory.
