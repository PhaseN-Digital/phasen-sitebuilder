// The app's JSON files (settings.json, accounts.json, site.json, publish.json),
// written so that overlapping saves or a crash can't corrupt or lose them (#147):
// - every write to a file goes through one in-process queue for that file, and
//   update() reads, changes and writes under it, so concurrent updates merge;
// - writes are atomic: a temp file in the same folder, fsync, then rename;
// - each successful write also refreshes <file>.bak, and a file that doesn't
//   parse is read from that backup (and logged) instead of becoming defaults.
// ponytail: the queue is in-process; a second running copy of the app could still
// interleave (atomic rename keeps the file valid, but one update would be lost).
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const queues = new Map();
function queued(file, fn) {
  const key = path.resolve(file);
  const run = (queues.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(key, tail);
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

async function writeAtomic(file, text) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${crypto.randomBytes(4).toString("hex")}`);
  try {
    const fh = await fs.open(tmp, "w");
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

const parseFile = (file) => fs.readFile(file, "utf8").then(JSON.parse);

// The file's value; fallback only when neither it nor its backup exists.
async function read(file, fallback) {
  try {
    return await parseFile(file);
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    try {
      const value = await parseFile(`${file}.bak`);
      console.error(`${file} is unreadable (${e.message}); using ${path.basename(file)}.bak`);
      return value;
    } catch (b) {
      console.error(`${file} is unreadable (${e.message}) and so is its backup (${b.message}); using defaults`);
      return fallback;
    }
  }
}

const save = async (file, value) => {
  const text = JSON.stringify(value, null, 2);
  await writeAtomic(file, text);
  await writeAtomic(`${file}.bak`, text);
};

const write = (file, value) => queued(file, () => save(file, value));

// Runs change(value) on the current contents and saves the result (change may
// mutate it or return a new value). Resolves to what was saved.
const update = (file, change, fallback = {}, migrate = (v) => v) => queued(file, async () => {
  const value = migrate(await read(file, structuredClone(fallback)));
  const next = (await change(value)) ?? value;
  await save(file, next);
  return next;
});

module.exports = { read, write, update };
