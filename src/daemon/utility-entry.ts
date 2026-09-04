/**
 * The daemon, hosted inside Electron's `utilityProcess`.
 *
 * This is what the packaged Windows app runs. It is the same daemon `pnpm daemon` runs — same
 * queue, same gate, same SQLite file — started through a different door, because the two
 * environments disagree about exactly one thing: how a parent asks a child to stop.
 *
 * `main.ts` starts itself when it is `argv[1]` and then listens for SIGINT/SIGTERM. Windows has
 * no SIGTERM: `utilityProcess.kill()` there is a `TerminateProcess`, and the daemon would lose
 * its job leases and its SQLite handle mid-write every time the window closed. Electron's parent
 * port is the only graceful stop that exists on that platform, so the app sends a message and
 * this file answers it. Keeping that here rather than in `main.ts` means the systemd unit, the
 * dev loop and the tests all go on looking at exactly the process they always have.
 *
 * VERIFIED with Electron 44.1.1 (Node 24.19.0): `utilityProcess.fork()` runs a `.ts` module as
 * is — type stripping is on by default in Node 24 — and messages travel in both directions over
 * the parent port. No build step, no flag, no Node installed on the target machine.
 *
 * NODE ONLY, and Electron only. Nothing else forks this.
 */

import { log } from "./log.ts"
import { startDaemon } from "./main.ts"

/**
 * What Electron hands a utility child. `@types/node` does not declare it — this is Electron's
 * own addition to `process`, not Node's — and it is genuinely absent when this file is run any
 * other way, so it is optional rather than asserted.
 */
interface ParentPort {
	on(event: "message", listener: (message: { data: unknown }) => void): void
	postMessage(message: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

const ctx = await startDaemon()

let stopping = false

/** One exit path for every way we can be asked to go, so a second ask cannot start a second one. */
const bye = (why: string, code = 0): void => {
	if (stopping) {
		log.warn(`${why} again — exiting immediately`)
		process.exit(1)
	}
	stopping = true
	log.info(`${why} — shutting down`)
	void ctx.shutdown().then(
		() => process.exit(code),
		err => {
			log.error("shutdown failed", { err: String(err) })
			process.exit(1)
		}
	)
	// The host kills this process a few seconds after asking, and a hung handler must not be
	// what decides whether the queue got to release its leases. Same guard as `main.ts`.
	setTimeout(() => process.exit(1), 10_000).unref?.()
}

if (parentPort)
	parentPort.on("message", message => {
		const type = (message.data as { type?: unknown } | null)?.type
		if (type === "shutdown") bye("the app asked us to stop")
	})
else log.warn("no parent port — nothing can ask this daemon to stop tidily")

// Still wired, because this same process is a normal POSIX child under WSL and Ctrl-C in the
// terminal that launched the app should not have to be a kill.
process.on("SIGTERM", () => bye("SIGTERM"))
process.on("SIGINT", () => bye("SIGINT"))

process.on("unhandledRejection", err => log.error("unhandled rejection", { err: String(err) }))
process.on("uncaughtException", err => {
	log.error("uncaught exception", { err: String(err) })
	// Everything durable is in SQLite, so a crash costs at most one attempt — and the app shows
	// a dialog naming the exit code rather than a window onto nothing.
	bye("uncaught exception", 1)
})
