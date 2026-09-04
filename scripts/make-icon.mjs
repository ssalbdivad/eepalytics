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

/**
 * Sizes inside the Windows `.ico`. Windows picks per surface: 16 in the title bar and the tray,
 * 32 in the taskbar, 48 in Alt-Tab and the file list, 256 in the large-icon view and on the
 * installer. 256 is the ceiling the format allows — a width of 0 in a directory entry MEANS 256,
 * and there is no encoding for 512.
 */
const ICO_SIZES = [16, 32, 48, 64, 128, 256]

app.disableHardwareAcceleration()

/**
 * Pack PNGs into a Windows `.ico`, by hand.
 *
 * WHY BY HAND. electron-builder will convert a PNG to an icon for you, and that conversion is
 * the one step of the Windows build that cannot be checked from Linux — it happens inside a
 * packaging run this machine cannot do. An icon that comes out blank looks exactly like an app
 * that has no icon, and the last icon bug in this repo took three attempts to spot. Writing the
 * file here means it is produced, and readable back, on the machine the art lives on.
 *
 * WHY BMP AND NOT PNG ENTRIES. An `.ico` may hold either. PNG-compressed entries are Vista-and-
 * later, and the installer toolchain is the least modern consumer in the chain, so every entry
 * here is the classic 32-bit DIB that every version of Windows has read since NT: a
 * BITMAPINFOHEADER whose height is doubled to cover the AND mask, BGRA rows stored bottom-up,
 * and an all-zero mask because the alpha channel already carries transparency.
 *
 * `nativeImage.toBitmap()` hands back exactly that BGRA byte order, top-down, so the only work
 * is reversing the rows.
 */
const buildIco = images => {
	const HEADER = 6
	const ENTRY = 16
	const dibs = images.map(({ size, bitmap }) => {
		const stride = size * 4
		// 1 bit per pixel, each ROW padded to a 4-byte boundary. Zero-filled: fully opaque.
		const maskBytes = ((size + 31) >> 5) * 4 * size
		const dib = Buffer.alloc(40 + stride * size + maskBytes)
		dib.writeUInt32LE(40, 0) // biSize
		dib.writeInt32LE(size, 4) // biWidth
		dib.writeInt32LE(size * 2, 8) // biHeight — XOR image plus the AND mask
		dib.writeUInt16LE(1, 12) // biPlanes
		dib.writeUInt16LE(32, 14) // biBitCount
		dib.writeUInt32LE(0, 16) // biCompression = BI_RGB
		dib.writeUInt32LE(stride * size + maskBytes, 20) // biSizeImage
		for (let row = 0; row < size; row++)
			// Bottom-up: the last source row is the first row in the file.
			bitmap.copy(dib, 40 + row * stride, (size - 1 - row) * stride, (size - row) * stride)
		return dib
	})

	const dir = Buffer.alloc(HEADER + ENTRY * images.length)
	dir.writeUInt16LE(0, 0) // reserved
	dir.writeUInt16LE(1, 2) // 1 = icon
	dir.writeUInt16LE(images.length, 4)
	let offset = dir.length
	images.forEach(({ size }, i) => {
		const at = HEADER + ENTRY * i
		// 0 means 256. The format spends one byte on each dimension and no more.
		dir.writeUInt8(size >= 256 ? 0 : size, at)
		dir.writeUInt8(size >= 256 ? 0 : size, at + 1)
		dir.writeUInt8(0, at + 2) // palette size — none, this is true colour
		dir.writeUInt8(0, at + 3) // reserved
		dir.writeUInt16LE(1, at + 4) // colour planes
		dir.writeUInt16LE(32, at + 6) // bits per pixel
		dir.writeUInt32LE(dibs[i].length, at + 8)
		dir.writeUInt32LE(offset, at + 12)
		offset += dibs[i].length
	})
	return Buffer.concat([dir, ...dibs])
}

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

	/*
	 * The Windows icon: the app's own, the installer's, and the one Explorer draws on the .exe.
	 * See `electron-builder.yml`.
	 *
	 * The ONE file that is not written to both public directories. The others are, because
	 * `src/web/public` is what Vite ships to the browser — but nothing in the browser can use an
	 * `.ico`, and it is a third of a megabyte to serve to nobody.
	 */
	const ico = buildIco(
		ICO_SIZES.map(size => ({
			size,
			bitmap: face.resize({ width: size, height: size, quality: "best" }).toBitmap()
		}))
	)
	writeFileSync(join(APP_PUBLIC, "icon.ico"), ico)
	console.log(`icon.ico  ${(ico.length / 1024).toFixed(1)} KB  ->  1 dir (${ICO_SIZES.join(", ")})`)

	for (const size of SPLASH_SIZES)
		emit(`splash-${size}.png`, art.resize({ width: size, height: size, quality: "best" }).toPNG())

	// The source art itself, so the splash markup can reference it without a build step.
	emit("lillia-art.png", art.toPNG())

	app.exit(0)
})
