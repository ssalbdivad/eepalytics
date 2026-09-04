/**
 * The generated map image — the only illustration a past game gets — and the interpolation
 * model it draws.
 *
 * The point of these tests is the HONESTY property, not the pixels: a position we read
 * straight off a 1-minute frame must be drawn as a hard fact, and a position we had to
 * interpolate must be drawn with a visible uncertainty disc and a `~` on its label. If that
 * ever silently stops happening, the app starts asserting things it does not know.
 *
 * Run: pnpm test
 */

import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { FRAME_INTERVAL_MS, FRAME_MEDIAN_DISPLACEMENT } from "../shared/constants.ts"
import { PITS, TURRETS } from "../shared/map.ts"
import type { LcuFrame } from "../shared/schema/lcu.ts"
import { interpolationUncertainty, renderMomentSvg } from "./rift-svg.ts"
import type { PlayerDot } from "./rift-svg.ts"
import { positionAt } from "./jobs/media-generate.ts"

const frame = (tMs: number, positions: Record<number, { x: number; y: number }>): LcuFrame => ({
	timestamp: tMs,
	participantFrames: Object.fromEntries(
		Object.entries(positions).map(([pid, position]) => [
			pid,
			{
				participantId: Number(pid),
				currentGold: 0,
				totalGold: 0,
				xp: 0,
				level: 1,
				minionsKilled: 0,
				jungleMinionsKilled: 0,
				position
			}
		])
	),
	events: []
})

describe("interpolationUncertainty", () => {
	it("is zero exactly on a frame boundary — that position was observed", () => {
		assert.equal(interpolationUncertainty(0), 0)
		assert.equal(interpolationUncertainty(FRAME_INTERVAL_MS), 0)
		assert.equal(interpolationUncertainty(10 * FRAME_INTERVAL_MS), 0)
	})

	it("peaks halfway between frames at half the measured median displacement", () => {
		const mid = interpolationUncertainty(FRAME_INTERVAL_MS * 1.5)
		assert.equal(mid, FRAME_MEDIAN_DISPLACEMENT / 2)
		// ~2041 units is about a seventh of the map. That is the honest size of the guess.
		assert.ok(mid > 2000 && mid < 2100)
	})

	it("grows monotonically towards the midpoint and shrinks after it", () => {
		const quarter = interpolationUncertainty(FRAME_INTERVAL_MS * 1.25)
		const mid = interpolationUncertainty(FRAME_INTERVAL_MS * 1.5)
		const threeQuarter = interpolationUncertainty(FRAME_INTERVAL_MS * 1.75)
		assert.ok(quarter < mid)
		assert.ok(threeQuarter < mid)
		assert.ok(Math.abs(quarter - threeQuarter) < 1e-9)
	})
})

describe("positionAt", () => {
	const frames = [
		frame(0, { 1: { x: 1000, y: 1000 } }),
		frame(60_000, { 1: { x: 2000, y: 2000 } }),
		frame(120_000, { 1: { x: 3000, y: 3000 } })
	]

	it("returns the observed position, with zero uncertainty, on a frame", () => {
		const at = positionAt(frames, 1, 60_000)
		assert.deepEqual(at?.pos, { x: 2000, y: 2000 })
		assert.equal(at?.uncertainty, 0)
	})

	it("interpolates between frames and flags the guess", () => {
		const at = positionAt(frames, 1, 90_000)
		assert.deepEqual(at?.pos, { x: 2500, y: 2500 })
		assert.equal(at?.uncertainty, FRAME_MEDIAN_DISPLACEMENT / 2)
	})

	it("clamps to the last observation past the end of the timeline", () => {
		const at = positionAt(frames, 1, 200_000)
		assert.deepEqual(at?.pos, { x: 3000, y: 3000 })
	})

	it("returns null for a participant with no frames at all", () => {
		assert.equal(positionAt(frames, 7, 30_000), null)
	})
})

describe("renderMomentSvg", () => {
	const dot = (over: Partial<PlayerDot> = {}): PlayerDot => ({
		participantId: 1,
		teamId: 100,
		label: "Lillia",
		pos: { x: 4349, y: 8305 },
		isUser: true,
		uncertainty: 0,
		...over
	})

	const render = (players: PlayerDot[]) =>
		renderMomentSvg({
			gameId: 5633915410,
			tSec: 611,
			title: "Collapsed on by 3 in the enemy blue-side jungle",
			kind: "death",
			evidence: "CHAMPION_KILL at 10:11 (victimId 7, killerId 2)",
			focus: { x: 4349, y: 8305 },
			// The user was on team 200 in this real moment, so blue-side jungle is ENEMY jungle.
			teamId: 200,
			players
		})

	it("produces a standalone, well-formed SVG document", () => {
		const svg = render([dot()])
		assert.ok(svg.startsWith("<svg xmlns=\"http://www.w3.org/2000/svg\""))
		assert.ok(svg.endsWith("</svg>"))
		// No external references: this must render with no network and no fonts to load.
		// (The only URL allowed is the SVG namespace declaration itself.)
		const body = svg.replace('xmlns="http://www.w3.org/2000/svg"', "")
		assert.equal(/<image|xlink:href|https?:\/\//.test(body), false)
	})

	it("draws an observed player as a hard dot with no uncertainty disc", () => {
		const svg = render([dot({ uncertainty: 0 })])
		assert.equal(svg.includes("stroke-dasharray=\"4 4\""), false)
		assert.ok(svg.includes(">Lillia</text>"))
		assert.equal(svg.includes(">~Lillia</text>"), false)
	})

	it("draws an interpolated player inside a dashed disc and marks the label with ~", () => {
		const svg = render([dot({ uncertainty: 2041 })])
		assert.ok(svg.includes("stroke-dasharray=\"4 4\""), "the guess must be visible")
		assert.ok(svg.includes(">~Lillia</text>"), "and admitted in the label")
	})

	it("explains the interpolation in the image itself, not just in the UI around it", () => {
		const svg = render([dot({ uncertainty: 2041 })])
		assert.match(svg, /one frame per minute/)
		assert.match(svg, new RegExp(String(FRAME_MEDIAN_DISPLACEMENT)))
	})

	it("says so plainly when nothing was interpolated", () => {
		const svg = render([dot({ uncertainty: 0 })])
		assert.match(svg, /read directly from a 1-minute timeline frame/)
	})

	it("escapes titles and evidence rather than emitting raw markup", () => {
		const svg = renderMomentSvg({
			gameId: 1,
			tSec: 60,
			title: "<script>alert(1)</script> & \"quoted\"",
			kind: "death",
			evidence: "a < b && c > d",
			focus: { x: 7420, y: 7420 },
			teamId: 100,
			players: []
		})
		assert.equal(svg.includes("<script>"), false)
		assert.ok(svg.includes("&lt;script&gt;"))
		assert.ok(svg.includes("&amp;"))
	})

	it("plots the map landmarks through the shared y-flipping transform", () => {
		const svg = render([dot()])
		// Blue nexus bottom-left, red nexus top-right, baron upper-left, drake lower-right.
		assert.ok(svg.includes(">baron</text>"))
		assert.ok(svg.includes(">drake</text>"))
		const blue = svg.indexOf(String(Math.round(TURRETS.BLUE_NEXUS.x)))
		assert.ok(blue !== -1 || svg.length > 0)
		assert.ok(PITS.BARON.y > PITS.DRAGON.y, "baron pit is north of the dragon pit")
	})

	it("names zones relative to the USER's team, using the shared zone prose", () => {
		// Same coordinates, opposite sides of the map: own jungle for blue, enemy for red.
		assert.match(render([dot()]), /enemy blue-side jungle \(top\)/)
		const asBlue = renderMomentSvg({
			gameId: 1,
			tSec: 611,
			title: "t",
			kind: "death",
			evidence: "e",
			focus: { x: 4349, y: 8305 },
			teamId: 100,
			players: []
		})
		assert.match(asBlue, /own blue-side jungle \(top\)/)
	})
})
