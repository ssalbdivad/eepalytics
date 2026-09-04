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
 * THE CROP. Read off a coordinate grid laid over the art rather than estimated. Her hair starts at
 * y≈205, the glasses sit at y≈375, her chin at y≈470, and — the measurement that matters most —
 * her ear tips are at x≈88 and x≈535. A first attempt cropped x 150–480 while claiming to keep
 * both ears, and clipped both; the numbers are written down here so the next person checks them
 * against the art instead of trusting the sentence.
 *
 * `AVATAR` is the SMALLEST square that still contains both ears with visible margin, and that is
 * a deliberate ceiling rather than a preference. The geometry is fixed and worth writing down,
 * because the three obvious goals cannot all be had:
 *
 *   ear tips at 88 and 535  ->  the crop can never be narrower than ~455px
 *   the library at x < 45   ->  costs another ~55px of width on top of that
 *   a big face              ->  wants the crop as narrow as possible
 *
 * Measured as a share of the crop, her face is 48% of a 330px crop (which clips both ears), 35%
 * at 455, 32% at 500 (the narrowest that catches the shelves) and 29% at 560. So keeping the
 * library costs roughly a fifth of her face at icon sizes — and at 16 and 32px, where this thing
 * mostly lives, that is the difference between a character and a smudge. Ears win, the room does
 * not, and the full illustration carries the room on the splash instead.
 *
 * Candidates were rendered at 16, 32, 48, 64 and 128px before choosing, because an icon that only
 * works at 512 is not an icon.
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

/** The avatar crop, in source pixels. See the header for how these were found. */
const AVATAR = { x: 75, y: 185, width: 470, height: 470 }

/** Ear tips in source pixels — asserted below so a future crop cannot silently clip them again. */
const EAR_TIPS = { left: 88, right: 535 }

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
	if (width < AVATAR.x + AVATAR.width || height < AVATAR.y + AVATAR.height) {
		console.error(`source is too small for the avatar crop ${JSON.stringify(AVATAR)}`)
		app.exit(1)
		return
	}

	/*
	 * The ear check, in code rather than in a comment. Clipping them once was an accident; doing
	 * it twice would be a habit, and a cropped ear is invisible in a diff.
	 */
	const right = AVATAR.x + AVATAR.width
	if (AVATAR.x > EAR_TIPS.left || right < EAR_TIPS.right) {
		console.error(
			`crop x ${AVATAR.x}..${right} clips an ear (tips at ${EAR_TIPS.left} and ${EAR_TIPS.right})`
		)
		app.exit(1)
		return
	}

	const face = art.crop(AVATAR)
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
