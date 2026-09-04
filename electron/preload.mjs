/**
 * The renderer's only bridge to the shell.
 *
 * Without this file the overlay's own resize and close buttons were permanently inert: both
 * windows are created with `contextIsolation: true, sandbox: true` and no preload, so
 * `window.electron` was never defined, `sendToShell` silently no-opped, and the `ipc-message`
 * handler in main.mjs could never fire. The overlay is frameless, so its ✕ was the only
 * in-window way to close it — and it did nothing.
 *
 * The surface is deliberately tiny and allow-listed. A renderer that can send arbitrary IPC
 * channels is a renderer that can drive the main process; this one can ask for exactly two
 * things and nothing else.
 */

import { contextBridge, ipcRenderer } from "electron"

const ALLOWED = new Set(["overlay:toggle-size", "overlay:close"])

contextBridge.exposeInMainWorld("electron", {
	ipcRenderer: {
		send: channel => {
			if (ALLOWED.has(channel)) ipcRenderer.send(channel)
		}
	}
})
