/**
 * Supervised, one-shot runtime verification of the capture path.
 *
 * THIS LAUNCHES A REPLAY IN THE USER'S REAL LEAGUE CLIENT. It refuses to do anything without
 * an explicit `--yes-launch-a-replay` flag, it refuses if the client is not idle, and it tears
 * the replay down in a `finally` no matter how it exits (including Ctrl-C).
 *
 * It runs the checklist from `.research/replay-capture.md` §9 and saves every raw response
 * under `data/logs/replay-probe-<gameId>/`, so the UNVERIFIED parts of that document
 * (camera axis mapping, clock alignment, png-folder naming, /Exit behaviour) get resolved
 * once, with evidence kept on disk instead of in someone's memory.
 *
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     src/capture/manual-test.ts --game 5631300987 --at 1042 --yes-launch-a-replay
 *
 * Add `--capture` to also take one screenshot and one clip.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { LOGS_DIR } from "../shared/constants.ts"
import { DEFAULT_CAMERA_CALIBRATION } from "./camera.ts"
import { launchReplay, preflight, sleep, teardown } from "./launcher.ts"
import { clip, screenshot } from "./recorder.ts"
import { curlClients } from "./transport.ts"

const argOf = (name: string): string | null => {
	const i = process.argv.indexOf(`--${name}`)
	return i === -1 ? null : (process.argv[i + 1] ?? null)
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)

const main = async (): Promise<number> => {
	const gameId = Number(argOf("game"))
	const atSec = Number(argOf("at") ?? 300)
	if (!Number.isFinite(gameId) || gameId <= 0) {
		console.error("usage: manual-test.ts --game <gameId> [--at <sec>] --yes-launch-a-replay")
		return 2
	}
	if (!flag("yes-launch-a-replay")) {
		console.error(
			"refusing to launch. This takes over your League client and steals the screen.\n" +
				"Re-run with --yes-launch-a-replay when you are NOT about to play."
		)
		return 2
	}

	const clients = curlClients()
	const outDir = `${LOGS_DIR}/replay-probe-${gameId}`
	await mkdir(outDir, { recursive: true })
	const save = async (name: string, body: unknown) => {
		await writeFile(
			`${outDir}/${name}`,
			typeof body === "string" ? body : JSON.stringify(body, null, 2)
		)
		console.log(`  saved ${name}`)
	}

	console.log("1. preflight")
	const verdict = await preflight(gameId, clients)
	await save("preflight.json", verdict)
	console.log(`   ${verdict.ok ? "OK" : "REFUSED"} — ${verdict.note}`)
	if (!verdict.ok) return 1

	const controller = new AbortController()
	const onSigint = () => {
		console.log("\n! aborting; the replay will be closed")
		controller.abort()
	}
	process.on("SIGINT", onSigint)

	let session = null as Awaited<ReturnType<typeof launchReplay>> | null
	try {
		console.log("2-3. launching (stopwatch running)")
		session = await launchReplay(gameId, {
			clients,
			signal: controller.signal,
			skipPreflight: true,
			// Leave the game's own directed camera alone: it is the calibration reference.
			applyScene: false,
			onPhase: (phase, note) => console.log(`   [${phase}] ${note}`)
		})
		console.log(`   Replay API up after ${session.launchMs} ms (record this number)`)

		console.log("4. swagger — this resolves every UNVERIFIED schema question at once")
		for (const [name, path] of [
			["replay-openapi.json", "/swagger/v3/openapi.json"],
			["replay-api-docs.json", "/swagger/v1/api-docs"]
		] as const) {
			const r = await clients.game.request("GET", path).catch(() => null)
			if (r) await save(name, r.body)
		}

		console.log("5-6. probing every endpoint")
		for (const [name, path] of [
			["replay-game.json", "/replay/game"],
			["replay-playback.json", "/replay/playback"],
			["replay-render.json", "/replay/render"],
			["replay-recording.json", "/replay/recording"],
			["replay-sequence.json", "/replay/sequence"],
			["replay-objects.json", "/replay/objects?types=hero&detail=true"],
			["replay-events.json", "/replay/events"],
			["live-gamestats.json", "/liveclientdata/gamestats"],
			["live-playerlist.json", "/liveclientdata/playerlist"],
			["live-eventdata.json", "/liveclientdata/eventdata"],
			["live-activeplayer.json", "/liveclientdata/activeplayer"]
		] as const) {
			const r = await clients.game.request("GET", path).catch(() => null)
			await save(name, r ? `HTTP ${r.status}\n${r.body}` : "TRANSPORT FAILURE")
		}

		console.log("7. camera calibration — directed camera vs hero positions")
		await session.setPlayback({ paused: false, speed: 1.0, time: atSec })
		const samples: unknown[] = []
		for (let i = 0; i < 3; i++) {
			await sleep(1500, controller.signal)
			samples.push({
				render: await session.getRender(),
				objects: await session.objects("hero", true),
				playback: await session.getPlayback(),
				assumedCalibration: DEFAULT_CAMERA_CALIBRATION
			})
		}
		await save("camera-calibration-samples.json", samples)
		console.log(
			"   compare cameraPosition against the followed champion's position;\n" +
				"   write the measured axis order / height / pitch into camera.ts"
		)

		console.log(`8. clock alignment — seeking to ${atSec}s`)
		const landed = await session.seek(atSec, controller.signal)
		const events = await clients.game
			.request("GET", "/liveclientdata/eventdata")
			.catch(() => null)
		await save("clock-alignment.json", {
			requested: atSec,
			landed,
			eventdata: events?.body ?? null
		})

		if (flag("capture")) {
			console.log("9-10. one screenshot and one clip")
			const shot = await screenshot({
				session,
				tSec: atSec,
				momentId: `probe-${gameId}-${atSec}`,
				signal: controller.signal
			})
			await save("screenshot-media.json", shot)
			const c = await clip({
				session,
				tSec: atSec,
				momentId: `probe-${gameId}-${atSec}`,
				clipSeconds: 10,
				signal: controller.signal
			})
			await save("clip-media.json", c)
		} else {
			console.log("9-10. skipped (pass --capture to record)")
		}

		return 0
	} catch (e) {
		console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`)
		return 1
	} finally {
		process.off("SIGINT", onSigint)
		console.log("11. teardown")
		const ok =
			session ? await session.close().catch(() => false)
			:	await teardown(clients, null).catch(() => false)
		console.log(
			ok ?
				"   client is out of the replay"
			:	"   !! COULD NOT CONFIRM TEARDOWN — check your client and close the replay manually"
		)
	}
}

const code = await main()
process.exit(code)
