// Preload for regression.js's single-instance check (#149): points the app at
// SB_USERDATA and logs what its main window does to SB_RESULT, one line each.
const { app } = require("electron");
const fs = require("node:fs");

app.setPath("userData", process.env.SB_USERDATA);
const log = (line) => fs.appendFileSync(process.env.SB_RESULT, `${line}\n`);
app.on("browser-window-created", (_e, win) => {
  win.webContents.once("did-finish-load", () => log("ready"));
  // Whether the OS actually hands over focus is up to the window manager
  // (xvfb has none, so it's flaky there): check main.js asks for it.
  const focus = win.focus;
  win.focus = function () { log("focus called"); return focus.call(this); };
  // Registered after main.js's handler, so this runs once that has.
  app.on("second-instance", () => log(`second-instance visible=${win.isVisible()} minimized=${win.isMinimized()}`));
});
