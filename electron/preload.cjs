/**
 * The one fact the page cannot work out for itself: which desktop this window is on.
 *
 * The live coach is a screen share, and a renderer can only ever see the compositor its own
 * process lives in. Under WSLg that compositor holds three virtual screens and this window;
 * the League client is a Windows process and is not in it. On a Windows install the same code
 * is a Windows process on the Windows desktop and the picker works normally.
 *
 * The page used to guess this from `navigator.userAgent`, which cannot tell those two apart in
 * the direction that matters — every Electron-on-Linux build answered "you must go to a browser",
 * including the Windows one if its UA were ever spoofed, and a Windows install would have
 * inherited the same advice the moment anything about the string changed. `process.platform` here
 * is the process that owns the window, which is the thing the question is actually about.
 *
 * CommonJS on purpose: this repo is `"type": "module"`, and a sandboxed preload must be CJS —
 * Electron only loads an ESM preload with the sandbox off, which is not a trade worth making for
 * eleven lines. Sandboxed preloads still get `contextBridge` and a `process` shim carrying
 * `platform` and `versions`, which is all this needs.
 *
 * Nothing here can act. It exposes two strings and no functions, so the renderer gains no new
 * powers — the page still reaches the daemon over HTTP like the browser build does.
 */

const { contextBridge } = require("electron")

contextBridge.exposeInMainWorld("eepalytics", {
	/** `linux` under WSLg, `win32` for the packaged Windows app. See `src/web/lib/capture-env.ts`. */
	platform: process.platform,
	/** Present only in the Electron shell, so the page can tell it apart from a browser tab. */
	electron: process.versions.electron
})
