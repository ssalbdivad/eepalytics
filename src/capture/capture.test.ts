/**
 * Capture unit tests.
 *
 * Everything here is pure or transport-mocked. NOTHING in this file launches a replay,
 * touches the League client, or writes to the user's filesystem — capture drives the real
 * game client, so the live path is verified deliberately and separately via
 * `src/capture/manual-test.ts`, never as a side effect of `pnpm test`.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
	DEFAULT_CAMERA_CALIBRATION,
	cameraForTarget,
	cameraHeightFor,
	eulerFor,
	frameMoment,
	groundOffsetForPitch,
	selectionOffsetFor,
	worldToCameraPosition,
	type CameraCalibration
} from "./camera.ts"
import {
	INITIAL_LAUNCH_STATUS,
	launchTransition,
	parseRoflHeader,
	roflFileName,
	roflPathFor,
	preflight,
	type LaunchSignal,
	type LaunchStatus
} from "./launcher.ts"
import {
	captureSlug,
	clipWindow,
	makeMediaId,
	pngSize,
	stagePaths,
	toWindowsPath,
	toWslPath
} from "./recorder.ts"
import { matchSelectionName, selectCaptureMoments } from "./pipeline.ts"
import { parseLockfile } from "./transport.ts"
import type { CaptureClients, HttpClient, RawReply } from "./types.ts"
import type { Moment } from "../shared/schema/domain.ts"

/* =========================================================== fixtures */

const moment = (over: Partial<Moment> = {}): Moment => ({
	id: "g1-death-100",
	gameId: 1,
	tSec: 100,
	kind: "death",
	title: "died",
	severity: 0.5,
	mapX: 7000,
	mapY: 7000,
	cameraTarget: null,
	participantsInvolved: [1],
	costGold: null,
	confidence: "medium",
	evidence: "CHAMPION_KILL @ 100s",
	...over
})

/** A canned LCU/game transport: path -> [status, jsonBody]. */
const fakeClient = (routes: Record<string, [number, unknown]>): HttpClient => ({
	request: async (_method, path): Promise<RawReply> => {
		const hit = routes[path.split("?")[0] as string]
		if (!hit) return { status: 404, body: '{"httpStatus":404}' }
		return { status: hit[0], body: JSON.stringify(hit[1]) }
	}
})

const fakeClients = (lcu: Record<string, [number, unknown]>): CaptureClients => ({
	lcu: fakeClient(lcu),
	game: fakeClient({})
})

const IDLE_CONFIG = {
	gameVersion: "16.17.810.4348",
	isInTournament: false,
	isLoggedIn: true,
	isPatching: false,
	isPlayingGame: false,
	isPlayingReplay: false,
	isReplaysEnabled: true,
	isReplaysForEndOfGameEnabled: true,
	isReplaysForMatchHistoryEnabled: true,
	minServerVersion: "",
	minutesUntilReplayConsideredLost: 30
}

/* ============================================================ rofl header */

describe("rofl header", () => {
	const buildHeader = (version: string): Uint8Array => {
		const buf = new Uint8Array(64)
		buf.set([0x52, 0x49, 0x4f, 0x54, 0x02, 0x00], 0)
		buf.set([0x37, 0x14, 0xcb, 0x24, 0x56, 0x62, 0x63, 0xe2], 6)
		buf[14] = version.length
		for (let i = 0; i < version.length; i++) buf[15 + i] = version.charCodeAt(i)
		return buf
	}

	it("parses the verified real-world header", () => {
		// Byte-for-byte the layout dumped from NA1-5631300987.rofl.
		const header = parseRoflHeader(buildHeader("16.17.810.4348"))
		assert.deepEqual(header, { gameVersion: "16.17.810.4348", patch: "16.17" })
	})

	it("rejects a non-ROFL2 file", () => {
		const buf = buildHeader("16.17.810.4348")
		buf[4] = 0x01 // ROFL1
		assert.equal(parseRoflHeader(buf), null)
	})

	it("rejects a truncated header", () => {
		assert.equal(parseRoflHeader(new Uint8Array(8)), null)
	})

	it("rejects a length byte that runs past the buffer", () => {
		const buf = buildHeader("16.17.810.4348")
		buf[14] = 200
		assert.equal(parseRoflHeader(buf), null)
	})

	it("names files the way the client does", () => {
		assert.equal(roflFileName(5631300987, "NA1"), "NA1-5631300987.rofl")
		assert.match(roflPathFor(5631300987, "NA1"), /Replays\/NA1-5631300987\.rofl$/)
	})
})

/* ======================================================== state machine */

describe("launch state machine", () => {
	const drive = (signals: LaunchSignal[]): LaunchStatus =>
		signals.reduce(launchTransition, INITIAL_LAUNCH_STATUS)

	it("walks the happy path to `up`", () => {
		const s = drive([
			{ kind: "start" },
			{ kind: "preflight-ok" },
			{ kind: "rofl-ready" },
			{ kind: "watch-accepted" },
			{ kind: "watch-accepted" },
			{ kind: "api-up" }
		])
		assert.deepEqual(s, { phase: "up", failure: null })
	})

	it("closes cleanly from `up`", () => {
		const s = drive([
			{ kind: "start" },
			{ kind: "preflight-ok" },
			{ kind: "rofl-ready" },
			{ kind: "watch-accepted" },
			{ kind: "api-up" },
			{ kind: "teardown" },
			{ kind: "closed" }
		])
		assert.deepEqual(s, { phase: "closed", failure: null })
	})

	it("routes an abort AFTER launch through teardown, never straight to failed", () => {
		const running = drive([
			{ kind: "start" },
			{ kind: "preflight-ok" },
			{ kind: "rofl-ready" },
			{ kind: "watch-accepted" },
			{ kind: "api-up" }
		])
		const aborting = launchTransition(running, { kind: "abort" })
		assert.equal(aborting.phase, "teardown", "a live game process must be torn down")
		assert.equal(aborting.failure, "aborted")
		assert.deepEqual(launchTransition(aborting, { kind: "closed" }), {
			phase: "failed",
			failure: "aborted"
		})
	})

	it("routes an abort BEFORE launch straight to failed (nothing to tear down)", () => {
		const s = launchTransition(
			drive([{ kind: "start" }, { kind: "preflight-ok" }]),
			{ kind: "abort" }
		)
		assert.deepEqual(s, { phase: "failed", failure: "aborted" })
	})

	it("keeps the refusal reason from preflight", () => {
		const s = drive([
			{ kind: "start" },
			{ kind: "preflight-refused", reason: "gated" }
		])
		assert.deepEqual(s, { phase: "failed", failure: "gated" })
	})

	it("tears down on a launch timeout rather than leaking the process", () => {
		const s = drive([
			{ kind: "start" },
			{ kind: "preflight-ok" },
			{ kind: "rofl-ready" },
			{ kind: "watch-accepted" },
			{ kind: "launch-timeout" }
		])
		assert.deepEqual(s, { phase: "teardown", failure: "launch-timeout" })
	})

	it("tears down on an api timeout", () => {
		const s = drive([
			{ kind: "start" },
			{ kind: "preflight-ok" },
			{ kind: "rofl-ready" },
			{ kind: "watch-accepted" },
			{ kind: "watch-accepted" },
			{ kind: "api-timeout" }
		])
		assert.deepEqual(s, { phase: "teardown", failure: "api-timeout" })
	})

	it("is terminal: a late signal cannot resurrect a failed machine", () => {
		const failed: LaunchStatus = { phase: "failed", failure: "api-timeout" }
		assert.deepEqual(launchTransition(failed, { kind: "api-up" }), failed)
		assert.deepEqual(launchTransition(failed, { kind: "abort" }), failed)
	})

	it("ignores signals that do not belong to the current phase", () => {
		const ready = drive([
			{ kind: "start" },
			{ kind: "preflight-ok" },
			{ kind: "rofl-ready" }
		])
		assert.deepEqual(launchTransition(ready, { kind: "api-up" }), ready)
	})
})

/* ============================================================ preflight */

describe("preflight", () => {
	it("refuses while the user is in a game", async () => {
		const v = await preflight(
			1,
			fakeClients({
				"/lol-replays/v1/configuration": [200, { ...IDLE_CONFIG, isPlayingGame: true }]
			})
		)
		assert.equal(v.ok, false)
		assert.equal(v.reason, "gated")
		assert.match(v.note, /in a game/)
	})

	it("refuses while a replay is already playing", async () => {
		const v = await preflight(
			1,
			fakeClients({
				"/lol-replays/v1/configuration": [200, { ...IDLE_CONFIG, isPlayingReplay: true }]
			})
		)
		assert.equal(v.reason, "gated")
	})

	it("refuses a non-idle gameflow phase (allowlist, fails closed)", async () => {
		const v = await preflight(
			1,
			fakeClients({
				"/lol-replays/v1/configuration": [200, IDLE_CONFIG],
				"/lol-gameflow/v1/gameflow-phase": [200, "ChampSelect"]
			})
		)
		assert.equal(v.reason, "gated")
		assert.match(v.note, /ChampSelect/)
	})

	it("refuses when a watch is already running", async () => {
		const v = await preflight(
			1,
			fakeClients({
				"/lol-replays/v1/configuration": [200, IDLE_CONFIG],
				"/lol-gameflow/v1/gameflow-phase": [200, "None"],
				"/lol-gameflow/v1/watch": [200, "WatchInProgress"]
			})
		)
		assert.equal(v.reason, "gated")
	})

	it("reports rofl-missing when the client is idle but the file is not there", async () => {
		const v = await preflight(
			// gameId 1 will never have a .rofl on disk.
			1,
			fakeClients({
				"/lol-replays/v1/configuration": [200, IDLE_CONFIG],
				"/lol-gameflow/v1/gameflow-phase": [200, "None"],
				"/lol-gameflow/v1/watch": [200, "None"]
			})
		)
		assert.equal(v.reason, "rofl-missing")
	})

	it("reports the client being unreachable as gated, not as a crash", async () => {
		const dead: CaptureClients = {
			lcu: {
				request: async () => {
					throw new Error("lockfile unreadable")
				}
			},
			game: fakeClient({})
		}
		const v = await preflight(1, dead)
		assert.equal(v.ok, false)
		assert.equal(v.reason, "gated")
	})
})

/* ========================================================== path bridge */

describe("WSL <-> Windows paths", () => {
	it("round-trips a real capture path", () => {
		const wsl = "/mnt/c/Users/ssalb/eepalytics-captures/g5631300987/shot"
		const win = toWindowsPath(wsl)
		assert.equal(win, "C:\\Users\\ssalb\\eepalytics-captures\\g5631300987\\shot")
		assert.equal(toWslPath(win as string), wsl)
	})

	it("accepts forward-slash Windows paths (which the LCU returns)", () => {
		assert.equal(
			toWslPath("C:/Users/ssalb/Documents/League of Legends/Replays"),
			"/mnt/c/Users/ssalb/Documents/League of Legends/Replays"
		)
	})

	it("refuses to mangle a WSL-native path the game cannot reach", () => {
		assert.equal(toWindowsPath("/home/ssalb/eepalytics/data"), null)
		assert.equal(toWslPath("/home/ssalb"), null)
	})

	it("uppercases the drive going out and lowercases it coming back", () => {
		assert.equal(toWindowsPath("/mnt/d/games"), "D:\\games")
		assert.equal(toWslPath("D:\\games"), "/mnt/d/games")
	})

	it("keeps the two views of a staging dir in sync", () => {
		const p = stagePaths(5631300987, "g1-death-100-png")
		assert.equal(toWslPath(p.win), p.wsl)
	})

	it("slugs moment ids into filesystem-safe names", () => {
		assert.equal(captureSlug("g5631300987-death-1042", 1042), "g5631300987-death-1042")
		assert.equal(captureSlug("weird/../id", 5), "weird____id")
		assert.equal(captureSlug(null, 1042.4), "t1042")
	})

	it("makes deterministic media ids", () => {
		assert.equal(makeMediaId(1, "g1-death-100", "screenshot", 100), "g1-death-100-screenshot")
		assert.equal(makeMediaId(1, "g1-death-100", "clip", 100), "g1-death-100-clip")
		assert.equal(makeMediaId(1, null, "screenshot", 100.6), "g1-t101-screenshot")
	})
})

/* ================================================================= png */

describe("png sizing", () => {
	it("reads the real dimensions out of an IHDR rather than trusting the request", () => {
		const buf = new Uint8Array(32)
		buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
		const view = new DataView(buf.buffer)
		view.setUint32(16, 1920)
		view.setUint32(20, 1080)
		assert.deepEqual(pngSize(buf), { width: 1920, height: 1080 })
	})

	it("returns null for a non-png", () => {
		assert.equal(pngSize(new Uint8Array(32)), null)
		assert.equal(pngSize(new Uint8Array(4)), null)
	})
})

/* =========================================================== clip window */

describe("clipWindow", () => {
	it("centres on the moment", () => {
		assert.deepEqual(clipWindow(100, 20), { startSec: 90, endSec: 110 })
	})

	it("never starts before the game did", () => {
		const w = clipWindow(4, 20)
		assert.equal(w.startSec, 0)
		assert.equal(w.endSec, 20)
	})

	it("slides back rather than running past the end of the replay", () => {
		const w = clipWindow(1845, 20, 1849)
		assert.equal(w.endSec, 1849)
		assert.equal(w.startSec, 1829)
	})

	it("clamps to the replay length even when the clip is longer than the game", () => {
		const w = clipWindow(5, 60, 30)
		assert.ok(w.startSec >= 0)
		assert.ok(w.endSec <= 30)
	})
})

/* =========================================================== camera math */

describe("camera", () => {
	it("puts height on Y for a Y-up engine", () => {
		assert.deepEqual(worldToCameraPosition({ x: 7000, y: 8000 }, 2000), {
			x: 7000,
			y: 2000,
			z: 8000
		})
	})

	it("honours a z-up recalibration without any other code changing", () => {
		const cal: CameraCalibration = { ...DEFAULT_CAMERA_CALIBRATION, heightAxis: "z-up" }
		assert.deepEqual(worldToCameraPosition({ x: 7000, y: 8000 }, 2000, cal), {
			x: 7000,
			y: 8000,
			z: 2000
		})
	})

	it("pulls the camera back by height/tan(pitch)", () => {
		// 45 degrees: the pull-back equals the height exactly.
		assert.ok(Math.abs(groundOffsetForPitch(2000, 45) - 2000) < 1e-6)
		// Straight down: no pull-back at all.
		assert.ok(groundOffsetForPitch(2000, 90) < 1e-9)
		// Shallower angles pull back further.
		assert.ok(groundOffsetForPitch(2000, 30) > groundOffsetForPitch(2000, 60))
	})

	it("aims at the target: the sight line lands on it", () => {
		const target = { x: 7000, y: 7000 }
		const shot = cameraForTarget(target, 2000, DEFAULT_CAMERA_CALIBRATION)
		// yaw 0 => camera sits at lower world-y and looks toward the target.
		assert.equal(shot.cameraPosition.x, 7000)
		assert.equal(shot.cameraPosition.y, 2000)
		assert.ok(shot.cameraPosition.z < 7000)
		assert.ok(Math.abs(7000 - shot.cameraPosition.z - shot.groundDistance) < 1e-6)
	})

	it("expresses the same framing as a selectionOffset", () => {
		const shot = cameraForTarget({ x: 0, y: 0 }, 2000)
		const off = selectionOffsetFor(2000)
		assert.deepEqual(off, shot.cameraPosition)
	})

	it("puts pitch and yaw where the calibration says", () => {
		assert.deepEqual(eulerFor(DEFAULT_CAMERA_CALIBRATION), { x: 60, y: 0, z: 0 })
		assert.deepEqual(
			eulerFor({ ...DEFAULT_CAMERA_CALIBRATION, rotationOrder: "yaw-pitch-roll" }),
			{ x: 0, y: 60, z: 0 }
		)
		assert.deepEqual(eulerFor({ ...DEFAULT_CAMERA_CALIBRATION, pitchSign: -1 }), {
			x: -60,
			y: 0,
			z: 0
		})
	})

	it("frames a teamfight wider than a cs moment", () => {
		assert.ok(cameraHeightFor("teamfight") > cameraHeightFor("cs_gap"))
	})

	it("prefers cameraTarget over the event position", () => {
		const r = frameMoment(
			moment({ kind: "objective_missed", cameraTarget: { x: 9866, y: 4414 } })
		)
		// Camera x tracks the *target*, not mapX.
		assert.equal(r.cameraPosition?.x, 9866)
	})

	it("uses selectionName when a champion is known, and no coordinates at all", () => {
		const r = frameMoment(moment(), { selectionName: "Viego" })
		assert.equal(r.selectionName, "Viego")
		assert.equal(r.cameraPosition, undefined)
		assert.ok(r.selectionOffset)
		assert.equal(r.cameraMode, "focus")
	})
})

/* ============================================================== pipeline */

describe("moment selection", () => {
	it("takes the most severe, then plays them back in game order", () => {
		const moments = [
			moment({ id: "a", tSec: 300, severity: 0.2 }),
			moment({ id: "b", tSec: 100, severity: 0.9 }),
			moment({ id: "c", tSec: 200, severity: 0.7 }),
			moment({ id: "d", tSec: 50, severity: 0.5 })
		]
		const picked = selectCaptureMoments(moments, 3)
		assert.deepEqual(
			picked.map(m => m.id),
			["d", "b", "c"],
			"ascending tSec keeps every seek a short forward scrub"
		)
	})

	it("respects a zero budget", () => {
		assert.deepEqual(selectCaptureMoments([moment()], 0), [])
	})

	it("does not invent moments when the budget exceeds what exists", () => {
		assert.equal(selectCaptureMoments([moment()], 10).length, 1)
	})
})

describe("selectionName resolution", () => {
	const objects = [
		{ characterName: "Viego", netId: 1 },
		{ characterName: "Lee Sin", netId: 2 }
	]

	it("matches case- and punctuation-insensitively", () => {
		assert.equal(matchSelectionName(objects, "viego"), "Viego")
		assert.equal(matchSelectionName(objects, "LeeSin"), "Lee Sin")
	})

	it("returns null rather than guessing", () => {
		assert.equal(matchSelectionName(objects, "Nunu & Willump"), null)
		assert.equal(matchSelectionName(objects, null), null)
		assert.equal(matchSelectionName([], "Viego"), null)
	})
})

/* ============================================================= lockfile */

describe("lockfile", () => {
	it("parses the verified five-field form with no trailing newline", () => {
		assert.deepEqual(parseLockfile("LeagueClient:6456:50924:abcDEF123:https"), {
			name: "LeagueClient",
			pid: 6456,
			port: 50924,
			password: "abcDEF123",
			protocol: "https"
		})
	})

	it("tolerates a trailing newline anyway", () => {
		assert.equal(parseLockfile("LeagueClient:1:2:p:https\n")?.port, 2)
	})

	it("returns null for junk instead of throwing", () => {
		assert.equal(parseLockfile(""), null)
		assert.equal(parseLockfile("LeagueClient:6456"), null)
		assert.equal(parseLockfile("LeagueClient:x:notaport:p:https"), null)
	})
})
