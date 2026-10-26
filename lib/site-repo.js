// Site history (#136): every site folder is its own git repo, through
// isomorphic-git (pure JS, so no git needed on the user's machine). main.js
// commits edits in batches, tags each publish, and lists/reverts versions here.
//
// Never committed, whatever .gitignore says: .secrets/ (and any secrets.enc),
// which is where lib/secrets.js keeps the site's encrypted secrets. Preview and
// publish builds live in userData, outside the site folder.
const fs = require("node:fs");
const path = require("node:path");
const git = require("isomorphic-git");

const GITIGNORE = "# Written by PhaseN Site Builder. Secrets are never committed, even if this file changes.\n.secrets/\n*.bak\n.*.tmp-*\n";
const forbidden = (f) => /(^|\/)(\.secrets(\/|$)|secrets\.enc)/.test(f);
// Left as they are by a revert: they describe what's live and which accounts it's on, not content.
const KEEP = new Set(["publish.json", "accounts.json", ".gitignore"]);
const LARGE = 50e6; // GitHub warns at 50MB and refuses files over 100MB

// One operation at a time per repo: isomorphic-git doesn't lock the index.
// Exported with commitNow for lib/sync.js, which runs inside the same queue.
const queues = new Map();
function queued(dir, fn) {
  const run = (queues.get(dir) || Promise.resolve()).then(fn, fn);
  queues.set(dir, run.catch(() => {}));
  return run;
}

const exists = (f) => fs.promises.stat(f).then(() => true, () => false);
const isRepo = (dir) => exists(path.join(dir, ".git"));

const readJson = (text) => { try { return JSON.parse(text); } catch { return null; } };
const siteAt = (dir, oid) => oid
  ? git.readBlob({ fs, dir, oid, filepath: "site.json" }).then((b) => readJson(Buffer.from(b.blob).toString("utf8")), () => null)
  : fs.promises.readFile(path.join(dir, "site.json"), "utf8").then(readJson, () => null);

// What changed, page by page, for a commit message or the History view.
function summarize(a, b, files) {
  const out = [];
  if (!a) return b ? ["Created the website"] : [];
  if (b) {
    const pages = (s) => new Map((s.pages || []).map((p) => [p.id, p]));
    const A = pages(a), B = pages(b);
    for (const [id, p] of B) {
      const old = A.get(id);
      if (!old) out.push(`Added page ${p.title}`);
      else if (old.title !== p.title) out.push(`Renamed page ${old.title} to ${p.title}`);
      else if (JSON.stringify(old) !== JSON.stringify(p)) out.push(`Edited page ${p.title}`);
    }
    for (const [id, p] of A) if (!B.has(id)) out.push(`Removed page ${p.title}`);
    const kept = (m, other) => [...m.keys()].filter((id) => other.has(id)).join();
    if (kept(A, B) !== kept(B, A)) out.push("Reordered pages");
    const norm = (v) => (v && typeof v === "object" && !Object.keys(v).length ? null : v ?? null); // {} or missing: nothing set
    const differ = (...keys) => keys.some((k) => JSON.stringify(norm(a[k])) !== JSON.stringify(norm(b[k])));
    if (differ("forms")) out.push("Changed forms");
    if (differ("theme", "themeSource", "colors", "font", "logo")) out.push("Changed design");
    if (differ("name", "description", "domain", "overrides", "importProvenance", "mirror", "workerName", "analyticsId")) out.push("Changed website settings");
    const byFile = new Map((b.pages || []).filter((p) => p.mirror).map((p) => [`mirror/${p.file}`, p.title]));
    for (const t of new Set(files.filter((f) => byFile.has(f)).map((f) => byFile.get(f)))) out.push(`Edited copied page ${t}`);
  }
  if (files.some((f) => f.startsWith("assets/"))) out.push("Changed images");
  if (files.some((f) => f.startsWith("theme/"))) out.push("Updated the theme");
  if (files.includes("publish.json")) out.push("Updated publishing details");
  if (files.includes("accounts.json")) out.push("Changed the website's accounts");
  return out;
}
const message = (lines) => (lines.length ? `${lines.slice(0, 3).join("; ")}${lines.length > 3 ? ` and ${lines.length - 3} more` : ""}\n\n${lines.join("\n")}\n` : "Saved changes\n");

async function commitNow(dir, msg, author) {
  // Belt and braces: a secrets file that's somehow in the index comes straight out.
  for (const f of (await git.listFiles({ fs, dir }).catch(() => [])).filter(forbidden)) await git.remove({ fs, dir, filepath: f });
  const rows = await git.statusMatrix({ fs, dir, filter: (f) => !forbidden(f) });
  const changed = rows.filter(([, head, work, stage]) => head !== work || work !== stage);
  if (!changed.length) return null;
  for (const [f, , work] of changed) {
    if (work === 0) await git.remove({ fs, dir, filepath: f });
    else await git.add({ fs, dir, filepath: f });
  }
  const files = changed.map(([f]) => f);
  if (files.some(forbidden)) throw new Error("Refusing to commit secrets."); // unreachable unless the filter above breaks
  const head = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
  const text = msg || message(summarize(await siteAt(dir, head), await siteAt(dir, null), files));
  return git.commit({ fs, dir, message: text, author });
}

// Commits whatever changed (nothing changed: null). Without a message, it's written from summarize().
const commit = (dir, msg, author) => queued(dir, () => commitNow(dir, msg, author));

// Makes dir a repo with a first commit, unless it already is one. Returns whether it did.
const ensure = (dir, author, msg = "Started this website's history") => queued(dir, async () => {
  if (await isRepo(dir)) return false;
  await git.init({ fs, dir, defaultBranch: "main" });
  if (!(await exists(path.join(dir, ".gitignore")))) await fs.promises.writeFile(path.join(dir, ".gitignore"), GITIGNORE);
  await commitNow(dir, msg, author);
  return true;
});

// Tags HEAD, adding -2, -3… if the name is taken. Returns the tag.
const tag = (dir, name) => queued(dir, async () => {
  const taken = new Set(await git.listTags({ fs, dir }));
  let t = name;
  for (let i = 2; taken.has(t); i++) t = `${name}-${i}`;
  await git.tag({ fs, dir, ref: t });
  return t;
});

async function log(dir, depth = 200) {
  const tags = new Map();
  for (const t of await git.listTags({ fs, dir })) {
    const oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${t}` });
    tags.set(oid, [...(tags.get(oid) || []), t]);
  }
  return (await git.log({ fs, dir, depth })).map(({ oid, commit: c }) => ({
    oid, message: c.message.split("\n")[0], date: c.author.timestamp * 1000, tags: tags.get(oid) || [],
  }));
}

// Files that differ between two commits (a may be null: everything in b).
async function changedFiles(dir, a, b) {
  const files = [];
  await git.walk({ fs, dir, trees: [git.TREE({ ref: a || b }), git.TREE({ ref: b })], map: async (f, [x, y]) => {
    if (f === ".") return true;
    const [tx, ty] = [x && (await x.type()), y && (await y.type())];
    if (tx === "tree" || ty === "tree") return a && x && y && (await x.oid()) === (await y.oid()) ? null : true; // unchanged folder: skip it
    if (!a || !x || !y || (await x.oid()) !== (await y.oid())) files.push(f);
    return true;
  } });
  return files;
}

// The page-level summary of one commit, against its parent.
async function changes(dir, oid) {
  const { commit: c } = await git.readCommit({ fs, dir, oid });
  const parent = c.parent[0] || null;
  return summarize(parent && (await siteAt(dir, parent)), await siteAt(dir, oid), await changedFiles(dir, parent, oid));
}

// Puts the site's files back as they were at oid and commits that as a new version
// (history is never rewritten). Uncommitted edits are committed first, so they can be got back too.
const revert = (dir, oid, author) => queued(dir, async () => {
  await commitNow(dir, null, author);
  const { commit: c } = await git.readCommit({ fs, dir, oid });
  const target = new Set((await git.listFiles({ fs, dir, ref: oid })).filter((f) => !KEEP.has(f) && !forbidden(f)));
  for (const f of await git.listFiles({ fs, dir, ref: "HEAD" })) {
    if (!target.has(f) && !KEEP.has(f) && !forbidden(f)) await fs.promises.rm(path.join(dir, f), { force: true });
  }
  for (const f of target) {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: f });
    await fs.promises.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
    await fs.promises.writeFile(path.join(dir, f), blob);
  }
  const when = new Date(c.author.timestamp * 1000).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  return commitNow(dir, `Restored the version from ${when}\n\n${c.message}`, author);
});

// Tracked files GitHub would warn about or refuse (sites are only pushed anywhere later, #136 follow-ups).
async function largeFiles(dir) {
  const out = [];
  for (const f of await git.listFiles({ fs, dir, ref: "HEAD" }).catch(() => [])) {
    const size = (await fs.promises.stat(path.join(dir, f)).catch(() => null))?.size || 0;
    if (size >= LARGE) out.push({ file: f, size });
  }
  return out;
}

module.exports = { GITIGNORE, forbidden, isRepo, queued, commitNow, ensure, commit, tag, log, changes, revert, summarize, largeFiles };
