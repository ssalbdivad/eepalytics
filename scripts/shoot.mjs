/**
 * Screenshot the running UI, so changes can be checked instead of assumed.
 *
 * Uses Electron rather than headless Chrome: Chrome-via-WSL-interop was unreliable here
 * (repeated timeouts writing no file), and Electron is already a dependency and already proven
 * to render and capture in `scripts/make-icon.mjs`.
 *
 * Usage:
 *   electron scripts/shoot.mjs <out.png> [route] [width] [height]
 *   electron scripts/shoot.mjs /tmp/games.png "#/games" 1500 1000
 *
 * Captures the FULL page height, not just the viewport, by measuring the document after load
 * and resizing to fit — a screenshot that silently crops is worse than none, because it hides
 * exactly the overflow bugs this exists to catch.
 */

import { app, BrowserWindow } from "electron"
import { writeFileSync } from "node:fs"

const [out = "/tmp/shot.png", route = "#/games", w = "1500", h = "1000"] = process.argv.slice(2)
const BASE = process.env.CSK_SHOT_BASE ?? "http://127.0.0.1:7700"

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
	const win = new BrowserWindow({
		width: Number(w),
		height: Number(h),
		show: false,
		webPreferences: { offscreen: true }
	})

	await win.loadURL(`${BASE}/${route.startsWith("#") ? route : `#/${route}`}`)
	// Let React render, fetch and settle. The pages poll, so a beat here avoids capturing
	// skeleton loaders and calling it a layout.
	await new Promise(r => setTimeout(r, 2500))

	// Full-height capture: resize the window to the document so nothing is cropped away.
	const full = await win.webContents.executeJavaScript(
		`({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth })`
	)
	const height = Math.min(Math.max(full.h, Number(h)), 4000)
	win.setContentSize(Number(w), height)
	await new Promise(r => setTimeout(r, 700))

	const img = await win.webContents.capturePage()
	writeFileSync(out, img.toPNG())
	// scrollWidth > viewport is the horizontal-overflow bug, reported rather than left to the eye.
	console.log(
		JSON.stringify({
			out,
			captured: img.getSize(),
			documentWidth: full.w,
			viewportWidth: Number(w),
			horizontalOverflow: full.w > Number(w)
		})
	)
	app.exit(0)
})
