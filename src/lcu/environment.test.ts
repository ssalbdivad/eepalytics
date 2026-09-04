/**
 * Host detection, against strings taken off real machines.
 *
 * The whole point of `readEnvironment` is that no single marker is trusted, so the cases that
 * matter are the ones where markers are *missing*: a systemd user unit whose environment has
 * no `WSL_*` variables is the configuration this app actually ships in, and a detector that
 * needed them would send the daemon down the native path on the one machine where native
 * cannot work.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict"
import { describe, it } from "node:test"
import { readEnvironment } from "./environment.ts"
import type { EnvironmentProbe } from "./environment.ts"

/** Verbatim from this machine. */
const WSL_PROC_VERSION =
	"Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1) (gcc (GCC) 11.2.0, GNU ld (GNU Binutils) 2.37) #1 SMP Fri Mar 29 23:14:13 UTC 2024\n"

const probe = (over: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
	platform: "linux",
	env: {},
	kernelText: "",
	presentPaths: [],
	...over
})

describe("readEnvironment", () => {
	it("calls this machine WSL from the kernel string alone, with no WSL_* variables set", () => {
		// A `systemd --user` unit gets a scrubbed environment on some setups. The kernel does not
		// change, so this is the signal that has to carry the case.
		const facts = readEnvironment(probe({ kernelText: WSL_PROC_VERSION }))
		strictEqual(facts.kind, "wsl")
		ok(facts.interopPossible, "WSL must keep the bridge and curl available")
		strictEqual(facts.directPlausible, "unknown")
		ok(facts.signals.includes("kernel:microsoft"))
	})

	it("still calls it WSL when only the environment variables survive", () => {
		// The mirror image: a rebuilt kernel with no marker, launched from a WSL shell.
		const facts = readEnvironment(
			probe({ env: { WSL_DISTRO_NAME: "Ubuntu", WSL_INTEROP: "/run/WSL/8_interop" } })
		)
		strictEqual(facts.kind, "wsl")
		deepStrictEqual(facts.signals, ["env:WSL_DISTRO_NAME", "env:WSL_INTEROP"])
	})

	it("still calls it WSL from an interop mount alone", () => {
		const facts = readEnvironment(probe({ presentPaths: ["/run/WSL", "/mnt/c/Windows"] }))
		strictEqual(facts.kind, "wsl")
		deepStrictEqual(facts.signals, ["path:/run/WSL", "path:/mnt/c/Windows"])
	})

	it("collects every signal that fired, because the log has to explain the choice", () => {
		const facts = readEnvironment(
			probe({
				kernelText: WSL_PROC_VERSION + "5.15.153.1-microsoft-standard-WSL2\n",
				env: { WSL_DISTRO_NAME: "Ubuntu" },
				presentPaths: ["/mnt/wsl"]
			})
		)
		deepStrictEqual(facts.signals, [
			"kernel:microsoft",
			"kernel:wsl",
			"env:WSL_DISTRO_NAME",
			"path:/mnt/wsl"
		])
	})

	it("says native Windows can go direct and cannot use interop", () => {
		const facts = readEnvironment(probe({ platform: "win32" }))
		strictEqual(facts.kind, "windows")
		strictEqual(facts.isWsl, false)
		strictEqual(facts.interopPossible, false)
		strictEqual(facts.directPlausible, "yes")
	})

	it("ignores Linux markers on win32 — a Windows box has no /proc to read", () => {
		// Belt and braces: if a caller ever hands us a probe with both, platform wins.
		const facts = readEnvironment(
			probe({ platform: "win32", kernelText: WSL_PROC_VERSION, presentPaths: ["/mnt/c/Windows"] })
		)
		strictEqual(facts.kind, "windows")
		strictEqual(facts.interopPossible, false)
	})

	it("treats a plain Linux box as not-WSL, so it never waits on interop that cannot exist", () => {
		const facts = readEnvironment(
			probe({ kernelText: "Linux version 6.8.0-generic (buildd@lcy02) #1 SMP\n" })
		)
		strictEqual(facts.kind, "linux")
		strictEqual(facts.isWsl, false)
		strictEqual(facts.interopPossible, false)
	})

	it("classifies mac", () => {
		strictEqual(readEnvironment(probe({ platform: "darwin" })).kind, "mac")
	})
})
