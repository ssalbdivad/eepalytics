/**
 * Rasterise `public/icon.svg` into the PNGs Electron needs for a window and taskbar icon.
 *
 * WHY ELECTRON AND NOT A LIBRARY. This machine has no rsvg-convert, no ImageMagick, no sharp and
 * no cairosvg, and adding a native image dependency to a local tool in order to draw one icon is
 * a poor trade. Electron is already a dependency and ships a full renderer, so it can load the
 * SVG and hand back a bitmap. The icon is regenerated only when the art changes, so the cost of
 * booting a renderer to do it is irrelevant.
 *
 * Run: pnpm icon
 */

import { app, BrowserWindow, nativeImage } from "electron"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SVG = join(ROOT, "public", "icon.svg")
const OUT = join(ROOT, "public", "icons")
const SIZES = [16, 32, 64, 128, 256, 512]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
	mkdirSync(OUT, { recursive: true })
	const svg = readFileSync(SVG, "utf8")

	// Rendered at the largest size once, then downscaled. Re-rendering per size would be
	// sharper in principle, but the art is vector-simple and Electron's resize is fine — and
	// one render keeps every size pixel-identical in composition.
	const largest = SIZES[SIZES.length - 1]
	const win = new BrowserWindow({
		width: largest,
		height: largest,
		show: false,
		frame: false,
		transparent: true,
		webPreferences: { offscreen: true }
	})

	// A data URL rather than a file URL: no path escaping, and the page is exactly the SVG on a
	// transparent ground with no margin to trim afterwards.
	const html = `<html><body style="margin:0;background:transparent">${svg.replace(
		/width="256" height="256"/,
		`width="${largest}" height="${largest}"`
	)}</body></html>`
	await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
	// Give the renderer a beat to paint before capturing.
	await new Promise(r => setTimeout(r, 400))

	const shot = await win.webContents.capturePage()
	if (shot.isEmpty()) {
		console.error("capture came back empty — the SVG did not render")
		app.exit(1)
		return
	}

	for (const size of SIZES) {
		const img = size === largest ? shot : shot.resize({ width: size, height: size, quality: "best" })
		const file = join(OUT, `icon-${size}.png`)
		writeFileSync(file, img.toPNG())
		console.log(`wrote ${file}`)
	}
	// The one Electron loads for the window/taskbar.
	writeFileSync(join(ROOT, "public", "icon.png"), shot.toPNG())
	console.log(`wrote ${join(ROOT, "public", "icon.png")}`)

	// Sanity: a PNG that decodes to nothing would silently give a blank taskbar icon.
	const check = nativeImage.createFromPath(join(ROOT, "public", "icon.png"))
	console.log("verified:", !check.isEmpty(), check.getSize())
	app.exit(0)
})
