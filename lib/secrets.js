// Secrets at rest (#136). The JSON files (settings.json, a site's accounts.json
// and publish.json) never hold a secret: every value under a SECRET_KEYS key is
// split out on write and kept, encrypted, in a secrets.enc next to them:
//   <sites folder>/.phasen/secrets.enc        the app's (settings.json)
//   <site folder>/.secrets/secrets.enc        a site's (accounts.json, publish.json)
// so the site folder can be a git repo (lib/site-repo.js never stages .secrets/).
//
// secrets.enc is a JSON envelope written through lib/json-store.js (atomic, .bak):
//   { v: 1, mode: "os", data }                Electron safeStorage (DPAPI/Keychain/libsecret)
//   { v: 1, mode: "portable", iv, tag, data } AES-256-GCM, key = scrypt(passphrase, salt)
// The passphrase is never stored; portable.json (in .phasen) holds its salt and a
// check value, and main.js remembers the derived key with safeStorage per machine.
// A file that can't be decrypted never crashes anything: its values are just
// missing (callers see "not connected"), problems() says why, and the next write
// of a changed secret moves the unreadable file aside rather than losing it.
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const json = require("./json-store");

const SECRET_KEYS = new Set(["token", "resendKey", "secret", "sendingKey", "password"]);

// { plain, secrets: [[path, value], ...] }; plain is a copy without the secret values.
function split(value) {
  const plain = structuredClone(value ?? {}), secrets = [];
  const walk = (o, at) => {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      if (SECRET_KEYS.has(k) && typeof o[k] === "string") {
        if (o[k]) secrets.push([[...at, k], o[k]]);
        delete o[k];
      } else walk(o[k], [...at, k]);
    }
  };
  walk(plain, []);
  return { plain, secrets };
}

// Puts secrets back where split() found them; one whose parent has gone is dropped.
function join(plain, secrets = []) {
  const value = structuredClone(plain);
  for (const [p, v] of secrets) {
    const parent = p.slice(0, -1).reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), value);
    if (parent && typeof parent === "object") parent[p.at(-1)] = v;
  }
  return value;
}

class SecretsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const LOCKED = "Your saved passwords and keys are protected with a passphrase (portable secrets). Enter it in Settings › Data to unlock them.";
const UNREADABLE = "Your saved passwords and keys couldn't be unlocked on this computer (they were saved on another computer, or the file is damaged). Re-enter your Cloudflare token and Resend key in Settings (and any a website uses on its own), then publish your websites again to re-create their keys.";

const deriveKey = (passphrase, salt) => new Promise((resolve, reject) =>
  crypto.scrypt(String(passphrase).normalize("NFC"), Buffer.from(salt, "base64"), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))));

// keyring: { safe: { encrypt(text) -> Buffer, decrypt(Buffer) -> text }, portable: bool, key: Buffer | null }
function encrypt(payload, keyring) {
  const text = JSON.stringify(payload);
  if (!keyring.portable) return { v: 1, mode: "os", data: keyring.safe.encrypt(text).toString("base64") };
  if (!keyring.key) throw new SecretsError("locked", LOCKED);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyring.key, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { v: 1, mode: "portable", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(env, keyring) {
  if (env?.mode === "portable" && !keyring.key) throw new SecretsError("locked", LOCKED);
  try {
    if (env?.v !== 1) throw new Error("unknown format");
    if (env.mode === "os") return JSON.parse(keyring.safe.decrypt(Buffer.from(env.data, "base64")));
    const d = crypto.createDecipheriv("aes-256-gcm", keyring.key, Buffer.from(env.iv, "base64"));
    d.setAuthTag(Buffer.from(env.tag, "base64"));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(env.data, "base64")), d.final()]).toString("utf8"));
  } catch (e) {
    throw new SecretsError("unreadable", UNREADABLE);
  }
}

// Why some secrets are missing, by secrets file. Cleared when that file reads or writes fine.
const issues = new Map();
const problems = () => [...new Set(issues.values())];

// json-store falls back to null both when the file is missing and when it (and its .bak) won't parse.
const damaged = (file) => fs.access(file).then(() => true, () => false);

async function readVault(file, keyring) {
  const env = await json.read(file, null);
  if (!env) {
    if (await damaged(file)) issues.set(file, UNREADABLE); else issues.delete(file);
    return {};
  }
  try {
    const data = decrypt(env, keyring);
    issues.delete(file);
    return data;
  } catch (e) {
    issues.set(file, e.message);
    return {};
  }
}

// Sets one name's secrets in the file. An unreadable file is kept aside, never overwritten;
// a locked one (portable, passphrase not entered yet) refuses the write.
async function writeVault(file, keyring, name, secrets) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await json.update(file, async (env) => {
    let data = {};
    if (!env && (await damaged(file))) await fs.copyFile(file, `${file}.unreadable-${Date.now()}`).catch(() => {});
    if (env) {
      try { data = decrypt(env, keyring); } catch (e) {
        if (e.code === "locked") throw e;
        await fs.copyFile(file, `${file}.unreadable-${Date.now()}`).catch(() => {});
      }
    }
    if (secrets.length) data[name] = secrets; else delete data[name];
    return encrypt(data, keyring);
  }, null);
  issues.delete(file);
}

// A JSON file whose secret values live in secretsFile under the file's name.
async function readJoined(file, secretsFile, keyring, fallback = {}) {
  const [value, vault] = await Promise.all([json.read(file, fallback), readVault(secretsFile, keyring)]);
  return value && join(value, vault[path.basename(file)]);
}

// json-store's update(), with the secrets split out (written first, and only when they changed).
// Resolves to the full value, secrets included.
async function updateJoined(file, secretsFile, keyring, change, fallback = {}, migrate = (v) => v) {
  const name = path.basename(file);
  let result;
  await json.update(file, async (plainOld) => {
    const vault = await readVault(secretsFile, keyring);
    const value = join(plainOld, vault[name]);
    result = (await change(value)) ?? value;
    const { plain, secrets } = split(result);
    if (JSON.stringify(secrets) !== JSON.stringify(vault[name] || [])) await writeVault(secretsFile, keyring, name, secrets);
    return plain;
  }, fallback, migrate);
  return result;
}

// Re-encrypts each existing secrets file from one keyring to another (turning portable secrets on/off).
// Files that can't be read with `from` are left alone and reported.
async function reencrypt(files, from, to) {
  const skipped = [];
  for (const file of files) {
    const env = await json.read(file, null);
    if (!env) continue;
    let data;
    try { data = decrypt(env, from); } catch { skipped.push(file); continue; }
    await json.write(file, encrypt(data, to));
  }
  return skipped;
}

// portable.json: the salt and a check value, so a wrong passphrase is told apart from a damaged file.
async function makePortable(passphrase) {
  const salt = crypto.randomBytes(16).toString("base64");
  const key = await deriveKey(passphrase, salt);
  return { key, config: { salt, check: encrypt({ check: "phasen" }, { portable: true, key }) } };
}
async function unlock(config, passphrase) {
  const key = await deriveKey(passphrase, config.salt);
  try { decrypt(config.check, { key }); } catch { throw new Error("That passphrase isn't the one these secrets were protected with."); }
  return key;
}

module.exports = { SECRET_KEYS, split, join, encrypt, decrypt, readJoined, updateJoined, readVault, reencrypt, makePortable, unlock, problems, SecretsError };
