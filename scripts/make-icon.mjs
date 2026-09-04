/**
 * Build the app icon: Riot's champion portrait with glasses drawn over it, rendered to the PNGs
 * Electron needs for a window and taskbar icon.
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
const OUT = join(ROOT, "public", "icons")
const SIZES = [16, 32, 64, 128, 256, 512]

app.disableHardwareAcceleration()

app.whenReady().then(async () => {
	mkdirSync(OUT, { recursive: true })
	// Riot's own champion portrait, base64'd so the renderer needs no file access.
	const portrait = readFileSync(join(ROOT, "public", "lillia-source.png")).toString("base64")

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
	/*
	 * Riot's portrait with glasses drawn over it, rather than an illustration of a fawn.
	 *
	 * The previous icon was hand-coded SVG and looked like it. This composites the official
	 * champion square — the same asset the app already displays for every game — and adds the
	 * one thing the joke needs. Eye positions were measured off the 128px source and scaled.
	 *
	 * `image-rendering: auto` matters: the source is 128px being drawn at 512, and the default
	 * nearest-neighbour upscale in some paths looks like a screenshot of a screenshot.
	 */
	const s = largest / 512
	const html = `<html><body style="margin:0;background:transparent">
	<div style="position:relative;width:${largest}px;height:${largest}px;border-radius:${
		Math.round(112 * s)
	}px;overflow:hidden;background:#07090e">
	  <img src="data:image/png;base64,${portrait}" width="${largest}" height="${largest}"
	       style="display:block;image-rendering:auto;filter:saturate(1.05) contrast(1.03)"/>
	  <svg width="${largest}" height="${largest}" viewBox="0 0 512 512"
	       style="position:absolute;inset:0">
	    <g fill="none" stroke="#15171d" stroke-width="14" stroke-linecap="round">
	      <circle cx="196" cy="252" r="54" fill="#dceefc" fill-opacity="0.18"/>
	      <circle cx="304" cy="242" r="54" fill="#dceefc" fill-opacity="0.18"/>
	      <path d="M250 247 L250 247"/>
	      <path d="M142 246 l-28 -12"/>
	      <path d="M358 238 l28 -12"/>
	    </g>
	    <path d="M172 228 a38 38 0 0 1 32 -20" stroke="#ffffff" stroke-opacity="0.68"
	          stroke-width="8" fill="none" stroke-linecap="round"/>
	    <path d="M282 218 a38 38 0 0 1 32 -20" stroke="#ffffff" stroke-opacity="0.68"
	          stroke-width="8" fill="none" stroke-linecap="round"/>
	  </svg>
	</div></body></html>`
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
