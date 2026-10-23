// electron-builder afterPack hook: drops workerd's ~140 MB binary (two copies
// once packaged) from the app. Only `wrangler dev` runs workerd, but wrangler
// loads miniflare, whose `workerd` import resolves the platform binary's path
// at load time and throws if the file is missing. So each binary is replaced
// with a small stub file rather than deleted. `npm run test:regression` uses
// the real node_modules, never this packaged copy.
const fs = require("node:fs");
const path = require("node:path");

const STUB = "workerd is not bundled with PhaseN Site Builder; only `wrangler dev` needs it.\n";

exports.default = async function afterPack(context) {
  const modules = path.join(context.packager.getResourcesDir(context.appOutDir), "app", "node_modules");
  fs.rmSync(path.join(modules, "workerd", "bin"), { recursive: true, force: true });
  const scope = path.join(modules, "@cloudflare");
  for (const pkg of fs.readdirSync(scope).filter((d) => d.startsWith("workerd-"))) {
    const bin = path.join(scope, pkg, "bin");
    // Unlink first: electron-builder may hardlink packaged files to node_modules,
    // and writing through the link would clobber the real binary there.
    for (const f of fs.readdirSync(bin)) {
      fs.rmSync(path.join(bin, f));
      fs.writeFileSync(path.join(bin, f), STUB);
    }
  }
};
