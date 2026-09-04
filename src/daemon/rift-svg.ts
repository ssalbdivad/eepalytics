/**
 * A self-contained SVG of Summoner's Rift with one moment plotted on it.
 *
 * THIS IS WHAT MAKES THE PRODUCT WORK. A real screenshot of a past game needs the League client,
 * an unexpired `.rofl`, an idle machine and the user's opt-in; four things that are often
 * false. A generated map needs nothing but the timeline we already stored, so EVERY moment
 * gets a picture and no piece of feedback is ever unillustrated.
 *
 * The honesty requirement is baked into the drawing, not bolted on as a caption:
 *   * A player observed exactly on a 1-minute frame boundary is drawn as a hard dot.
 *   * A player whose position had to be interpolated is drawn as a hard dot INSIDE a dashed
 *     uncertainty disc whose radius is the interpolation error model, and its label is
 *     prefixed with "~". Halfway between frames that disc is over 2000 game units across —
 *     about a seventh of the map — which is exactly the point. You can SEE that we do not
 *     know where they were.
 *
 * No external assets, no fonts to load, no network: one file the browser can render alone.
 *
 * Pure and browser-safe apart from its imports; kept in `src/daemon/` because the daemon is
 * the only thing that writes it.
 */

import { FRAME_INTERVAL_MS, FRAME_MEDIAN_DISPLACEMENT, MAP } from "../shared/constants.ts"
import { fmtClock } from "../shared/time.ts"
import {
	LANE_POLYLINES,
	PITS,
	TURRETS,
	toMinimapPct,
	zoneOf
} from "../shared/map.ts"
import type { Pos, TeamId } from "../shared/map.ts"

export interface PlayerDot {
	participantId: number
	teamId: TeamId
	/** Champion name when we know it, otherwise `P7`. Never invented. */
	label: string
	pos: Pos
	isUser: boolean
	/**
	 * Radius, in GAME UNITS, of where this player might actually have been. `0` means the
	 * moment landed on a frame boundary and the position is observed, not inferred.
	 */
	uncertainty: number
}

export interface MomentSvgInput {
	gameId: number
	tSec: number
	title: string
	kind: string
	evidence: string
	/** The moment's own position. */
	focus: Pos
	/** Where the replay camera should point, when that differs from `focus`. */
	camera?: Pos | null
	/** The user's team, so zone names read as own/enemy. */
	teamId: TeamId
	players: readonly PlayerDot[]
	size?: number
	/** Extra line under the title, e.g. "gold swing -1200". */
	subtitle?: string
}

/** Game units → pixels on a square canvas. */
const unitsToPx = (units: number, size: number): number =>
	(units / (MAP.maxX - MAP.minX)) * size

const at = (p: Pos, size: number): { x: number; y: number } => {
	const pct = toMinimapPct(p)
	return { x: (pct.left / 100) * size, y: (pct.top / 100) * size }
}

const esc = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")

const r2 = (n: number): string => (Math.round(n * 100) / 100).toString()

/**
 * How far a straight-line interpolation could be wrong, in game units.
 *
 * Frames are 60 s apart and the MEASURED median displacement between consecutive frames is
 * 4082 units. A player observed at both ends of an interval can be anywhere on a path between
 * them; the worst case is in the middle, so the deviation is modelled as
 * `median displacement x min(f, 1 - f)`, which is 0 at each observed frame and ~2041 units at
 * the midpoint. It is a model, not a measurement, and the SVG says so in its own caption.
 */
export const interpolationUncertainty = (tMs: number): number => {
	const f = (tMs % FRAME_INTERVAL_MS) / FRAME_INTERVAL_MS
	return FRAME_MEDIAN_DISPLACEMENT * Math.min(f, 1 - f)
}

const PALETTE = {
	bg: "#0d1117",
	panel: "#161b22",
	ink: "#e6edf3",
	dim: "#8b949e",
	terrain: "#1b2430",
	river: "#1f3d4d",
	lane: "#2b3a4a",
	blue: "#4493f8",
	red: "#f85149",
	user: "#f0b72f",
	focus: "#ff7b72"
} as const

const drawTerrain = (size: number): string => {
	const parts: string[] = []
	parts.push(
		`<rect x="0" y="0" width="${size}" height="${size}" fill="${PALETTE.terrain}" rx="${r2(size * 0.02)}"/>`
	)

	// The river runs perpendicular to the blue→red diagonal (u = (x+y)/2 = centerU).
	const riverHalf = unitsToPx(MAP.riverHalfU * Math.SQRT2, size)
	const c = at({ x: MAP.centerU, y: MAP.centerU }, size)
	parts.push(
		`<g transform="rotate(-45 ${r2(c.x)} ${r2(c.y)})">` +
			`<rect x="${r2(c.x - size)}" y="${r2(c.y - riverHalf)}" width="${r2(size * 2)}" ` +
			`height="${r2(riverHalf * 2)}" fill="${PALETTE.river}" opacity="0.55"/></g>`
	)

	for (const lane of ["TOP", "MID", "BOT"] as const) {
		const pts = LANE_POLYLINES[lane]
			.map(([x, y]) => {
				const q = at({ x, y }, size)
				return `${r2(q.x)},${r2(q.y)}`
			})
			.join(" ")
		parts.push(
			`<polyline points="${pts}" fill="none" stroke="${PALETTE.lane}" ` +
				`stroke-width="${r2(unitsToPx(1100, size))}" stroke-linecap="round" ` +
				`stroke-linejoin="round" opacity="0.85"/>`
		)
	}

	// Every turret coordinate below is exact: read straight out of BUILDING_KILL.position,
	// with zero spread across 22 games.
	for (const [name, pos] of Object.entries(TURRETS)) {
		const q = at(pos, size)
		const isBlue = name.startsWith("BLUE")
		parts.push(
			`<rect x="${r2(q.x - 3)}" y="${r2(q.y - 3)}" width="6" height="6" ` +
				`fill="${isBlue ? PALETTE.blue : PALETTE.red}" opacity="0.5"/>`
		)
	}

	for (const [name, pos] of Object.entries(PITS)) {
		if (name === "HERALD" || name === "GRUBS") continue // same pit as BARON
		const q = at(pos, size)
		parts.push(
			`<circle cx="${r2(q.x)}" cy="${r2(q.y)}" r="${r2(unitsToPx(MAP.pitRadius, size))}" ` +
				`fill="none" stroke="${PALETTE.dim}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`,
			`<text x="${r2(q.x)}" y="${r2(q.y + 3)}" font-size="9" fill="${PALETTE.dim}" ` +
				`text-anchor="middle" font-family="ui-monospace,monospace">${name === "BARON" ? "baron" : "drake"}</text>`
		)
	}

	return parts.join("")
}

const drawPlayer = (p: PlayerDot, size: number): string => {
	const q = at(p.pos, size)
	const color = p.isUser ? PALETTE.user : p.teamId === 100 ? PALETTE.blue : PALETTE.red
	const parts: string[] = []

	if (p.uncertainty > 1) {
		// The visible admission that we are guessing.
		parts.push(
			`<circle cx="${r2(q.x)}" cy="${r2(q.y)}" r="${r2(unitsToPx(p.uncertainty, size))}" ` +
				`fill="${color}" fill-opacity="0.07" stroke="${color}" stroke-opacity="0.45" ` +
				`stroke-width="1" stroke-dasharray="4 4"/>`
		)
	}
	parts.push(
		`<circle cx="${r2(q.x)}" cy="${r2(q.y)}" r="${p.isUser ? 7 : 5}" fill="${color}" ` +
			`stroke="${PALETTE.bg}" stroke-width="1.5"/>`
	)
	const label = `${p.uncertainty > 1 ? "~" : ""}${p.label}`
	parts.push(
		`<text x="${r2(q.x + 9)}" y="${r2(q.y + 4)}" font-size="11" fill="${color}" ` +
			`font-family="ui-sans-serif,system-ui,sans-serif" ` +
			`${p.isUser ? 'font-weight="700"' : ""}>${esc(label)}</text>`
	)
	return parts.join("")
}

/**
 * Render one moment. Returns a complete standalone SVG document.
 *
 * `size` is the map canvas; the finished image is `size` wide and `size + HEADER + FOOTER`
 * tall, so the caption travels with the picture into any context that shows it.
 */
export const renderMomentSvg = (input: MomentSvgInput): string => {
	const size = input.size ?? 640
	const header = 74
	const footer = 58
	const width = size
	const height = size + header + footer

	const anyInterpolated = input.players.some(p => p.uncertainty > 1)
	const zone = zoneOf(input.focus, input.teamId)
	const focusPx = at(input.focus, size)

	const body: string[] = []
	body.push(`<g transform="translate(0,${header})">`)
	body.push(drawTerrain(size))

	// The moment itself: a crosshair, drawn under the players so a dot is never hidden.
	body.push(
		`<circle cx="${r2(focusPx.x)}" cy="${r2(focusPx.y)}" r="18" fill="none" ` +
			`stroke="${PALETTE.focus}" stroke-width="2" opacity="0.9"/>`,
		`<line x1="${r2(focusPx.x - 26)}" y1="${r2(focusPx.y)}" x2="${r2(focusPx.x - 8)}" ` +
			`y2="${r2(focusPx.y)}" stroke="${PALETTE.focus}" stroke-width="2"/>`,
		`<line x1="${r2(focusPx.x + 8)}" y1="${r2(focusPx.y)}" x2="${r2(focusPx.x + 26)}" ` +
			`y2="${r2(focusPx.y)}" stroke="${PALETTE.focus}" stroke-width="2"/>`,
		`<line x1="${r2(focusPx.x)}" y1="${r2(focusPx.y - 26)}" x2="${r2(focusPx.x)}" ` +
			`y2="${r2(focusPx.y - 8)}" stroke="${PALETTE.focus}" stroke-width="2"/>`,
		`<line x1="${r2(focusPx.x)}" y1="${r2(focusPx.y + 8)}" x2="${r2(focusPx.x)}" ` +
			`y2="${r2(focusPx.y + 26)}" stroke="${PALETTE.focus}" stroke-width="2"/>`
	)

	if (input.camera) {
		const cam = at(input.camera, size)
		body.push(
			`<line x1="${r2(focusPx.x)}" y1="${r2(focusPx.y)}" x2="${r2(cam.x)}" y2="${r2(cam.y)}" ` +
				`stroke="${PALETTE.dim}" stroke-width="1" stroke-dasharray="2 4"/>`,
			`<rect x="${r2(cam.x - 7)}" y="${r2(cam.y - 5)}" width="14" height="10" fill="none" ` +
				`stroke="${PALETTE.dim}" stroke-width="1.5"/>`
		)
	}

	for (const p of input.players) body.push(drawPlayer(p, size))
	body.push("</g>")

	const caption =
		anyInterpolated ?
			`Dashed circles are where a player COULD have been: the client only records one frame ` +
			`per minute, so positions between frames are interpolated (median frame-to-frame move: ` +
			`${FRAME_MEDIAN_DISPLACEMENT} units).`
		:	`All positions read directly from a 1-minute timeline frame — no interpolation.`

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `,
		`viewBox="0 0 ${width} ${height}" role="img" `,
		`aria-label="${esc(`${input.title} at ${fmtClock(input.tSec)} in ${zone}`)}">`,
		`<title>${esc(input.title)} — ${fmtClock(input.tSec)}</title>`,
		`<desc>${esc(input.evidence)}</desc>`,
		`<rect width="${width}" height="${height}" fill="${PALETTE.bg}"/>`,
		`<text x="16" y="26" font-size="16" font-weight="700" fill="${PALETTE.ink}" `,
		`font-family="ui-sans-serif,system-ui,sans-serif">${esc(input.title)}</text>`,
		`<text x="16" y="46" font-size="12" fill="${PALETTE.dim}" `,
		`font-family="ui-monospace,monospace">${esc(
			`${fmtClock(input.tSec)}  ·  ${zone}  ·  ${input.kind}${
				input.subtitle ? `  ·  ${input.subtitle}` : ""
			}`
		)}</text>`,
		`<text x="16" y="64" font-size="11" fill="${PALETTE.dim}" `,
		`font-family="ui-sans-serif,system-ui,sans-serif">${esc(input.evidence)}</text>`,
		body.join(""),
		`<text x="16" y="${size + header + 22}" font-size="10" fill="${PALETTE.dim}" `,
		`font-family="ui-sans-serif,system-ui,sans-serif">${esc(caption)}</text>`,
		`<text x="16" y="${size + header + 40}" font-size="10" fill="${PALETTE.dim}" `,
		`font-family="ui-monospace,monospace">${esc(
			`game ${input.gameId}  ·  gold dot = you  ·  blue = team 100  ·  red = team 200`
		)}</text>`,
		`</svg>`
	].join("")
}
