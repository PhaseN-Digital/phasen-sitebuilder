// Preloaded (--require) before wrangler under ELECTRON_RUN_AS_NODE. yargs'
// hideBin sees process.versions.electron, assumes a packaged Electron app and
// strips one argv entry too few, so wrangler reads its own path as a command.
// defaultApp makes it strip two, like plain Node.
process.defaultApp = true;
