/**
 * Build the app icon and the splash from one piece of commissioned art.
 *
 * WHAT CHANGED, AND WHY THIS IS NOW SIMPLE. The previous version composited Riot's champion
 * portrait and drew glasses over it in hand-written SVG, because there was no art with glasses in
 * it. There is now — `public/lillia-art.png`, drawn to spec — so there is nothing to composite.
 * The whole job is a crop and a set of resizes.
 *
 * Electron's `nativeImage` does both natively, so this no longer boots a renderer, loads a data
 * URL, waits for paint, or captures a page. It also no longer carries the coordinates of her
 * eyes, which took three attempts to get right and, at one point, landed a pair of spectacles on
 * her forehead.
 *
 * THE CROP. Read off a coordinate grid laid over the art rather than estimated: her hair starts
 * at y≈205, the glasses sit at y≈375, her chin at y≈470, and her ear tips at x≈95 and x≈490.
 * `FACE` is the square that keeps both ears and the glasses while filling the frame with her
 * face — checked by rendering the candidates at 16, 32 and 64px, because an icon that only works
 * at 512 is not an icon.
 *
 * Run: pnpm icon
 */

import { app, nativeImage } from "electron"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * There are two public directories, and both are load-bearing.
 *
 * Vite's `root` is `src/web`, so its publicDir is `src/web/public` — that is what gets copied
 * into `dist/` and served to the browser. Electron reads its window icon straight off disk from
 * the project's own `public/`. Writing to only one of them is a silent failure: the icons landed
 * in the root `public/` for a whole release, the build shipped the previous set from
 * `src/web/public`, and the app went on showing the old avatar with every file on disk looking
 * correct.
 */
const WEB_PUBLIC = join(ROOT, "src", "web", "public")
const APP_PUBLIC = join(ROOT, "public")
const TARGETS = [WEB_PUBLIC, APP_PUBLIC]
const SIZES = [16, 32, 64, 128, 256, 512]

/** The face crop, in source pixels. See the header for how these were found. */
const FACE = { x: 150, y: 200, width: 330, height: 330 }

/**
 * Splash sizes. The art is 1024² and that is more than any splash needs, so it ships downscaled —
 * a 1.3MB PNG behind a window that appears for under a second is a poor trade.
 */
const SPLASH_SIZES = [512, 1024]

app.disableHardwareAcceleration()

/** Write one file into every public directory that needs it. */
const emit = (rel, buf) => {
	for (const dir of TARGETS) {
		const path = join(dir, rel)
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, buf)
	}
	console.log(`${rel}  ${(buf.length / 1024).toFixed(1)} KB  ->  ${TARGETS.length} dirs`)
}

app.whenReady().then(() => {
	const art = nativeImage.createFromPath(join(APP_PUBLIC, "lillia-art.png"))
	if (art.isEmpty()) {
		console.error("public/lillia-art.png is missing or unreadable")
		app.exit(1)
		return
	}
	const { width, height } = art.getSize()
	console.log(`source ${width}×${height}`)

	// Fail loudly rather than silently cropping black: the numbers above are tied to a 1024² source.
	if (width < FACE.x + FACE.width || height < FACE.y + FACE.height) {
		console.error(`source is too small for the face crop ${JSON.stringify(FACE)}`)
		app.exit(1)
		return
	}

	const face = art.crop(FACE)
	for (const size of SIZES)
		emit(join("icons", `icon-${size}.png`), face.resize({ width: size, height: size, quality: "best" }).toPNG())

	// Electron's window/taskbar icon, read straight off disk at launch.
	emit("icon.png", face.resize({ width: 512, height: 512, quality: "best" }).toPNG())

	for (const size of SPLASH_SIZES)
		emit(`splash-${size}.png`, art.resize({ width: size, height: size, quality: "best" }).toPNG())

	// The source art itself, so the splash markup can reference it without a build step.
	emit("lillia-art.png", art.toPNG())

	app.exit(0)
})
