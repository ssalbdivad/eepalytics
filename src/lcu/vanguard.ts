/**
 * Vanguard diagnostics — why the League client is not reachable.
 *
 * "The League client is not running" is true and useless. On Windows the overwhelmingly common
 * cause is Riot Vanguard, the kernel anti-cheat that must be up BEFORE League will start, and
 * whose failures are opaque: the client either refuses to launch or exits seconds later with a
 * `VAN-####` dialog that is gone before anyone reads it.
 *
 * This asks Windows directly instead of guessing. Two services matter:
 *
 *   - `vgk` — the kernel driver. Loads at boot. If it is stopped, League will not start, and
 *     the fix is almost always a REBOOT, because a driver that failed to load at boot cannot be
 *     started afterwards.
 *   - `vgc` — the user-mode service that talks to it.
 *
 * WHAT THIS CANNOT SEE. Both services can report RUNNING while Vanguard still refuses to let
 * League start — a pending post-update reboot is the usual case, and it is invisible from
 * outside. So a clean probe is reported as "no fault found here", never as "Vanguard is fine".
 * Claiming the latter would send the user hunting in the wrong place.
 *
 * NODE ONLY. Reads Windows service state through the same interop path everything else uses;
 * WSL cannot query Windows services any other way.
 */

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"

const run = promisify(execFile)

/** `sc.exe` on the Windows side. WSL has no equivalent — service state lives on the host. */
const SC_EXE = "/mnt/c/WINDOWS/system32/sc.exe"

export type ServiceState = "running" | "stopped" | "not-installed" | "unknown"

export interface VanguardStatus {
	/** The kernel driver. Must be loaded at boot for League to start at all. */
	vgk: ServiceState
	/** The user-mode service. */
	vgc: ServiceState
	/** True only when we could actually ask. False on non-Windows hosts or missing interop. */
	probed: boolean
	/**
	 * What to tell the user, in order of likelihood. Empty when nothing is provably wrong —
	 * which is NOT the same as "Vanguard is healthy". See the header.
	 */
	problems: string[]
	/** Steps worth trying, most likely first. Always populated when the client is unreachable. */
	advice: string[]
}

const parseState = (stdout: string): ServiceState =>
	/STATE\s+:\s*4\s+RUNNING/i.test(stdout) ? "running"
	: /STATE\s+:\s*1\s+STOPPED/i.test(stdout) ? "stopped"
	: /STATE\s+:/i.test(stdout) ? "unknown"
	: "not-installed"

const queryService = async (name: string): Promise<ServiceState> => {
	try {
		const { stdout } = await run(SC_EXE, ["query", name], { timeout: 8_000 })
		return parseState(stdout)
	} catch (err) {
		// `sc query` exits non-zero for a service that does not exist, and still prints a
		// message we can read. 1060 is "the specified service does not exist".
		const text = `${(err as { stdout?: string }).stdout ?? ""}${(err as Error).message ?? ""}`
		if (/1060/.test(text)) return "not-installed"
		return "unknown"
	}
}

/**
 * Ask Windows about Vanguard. Never throws — this runs on the "something is already wrong"
 * path, and a diagnostic that can itself fail is not a diagnostic.
 */
export const probeVanguard = async (): Promise<VanguardStatus> => {
	if (!existsSync(SC_EXE))
		return {
			vgk: "unknown",
			vgc: "unknown",
			probed: false,
			problems: [],
			advice: ["Start the League client, then reopen this page."]
		}

	const [vgk, vgc] = await Promise.all([queryService("vgk"), queryService("vgc")])

	const problems: string[] = []
	const advice: string[] = []

	if (vgk === "not-installed" && vgc === "not-installed") {
		problems.push("Riot Vanguard does not appear to be installed on this machine.")
		advice.push(
			"Reinstall Vanguard from the Riot client, or repair the League install. League will not launch without it."
		)
	} else {
		if (vgk === "stopped") {
			problems.push(
				"The Vanguard kernel driver (vgk) is STOPPED. League will not start while it is."
			)
			advice.push(
				"Reboot Windows. vgk loads at boot and generally cannot be started by hand afterwards — this is the fix in most cases."
			)
		}
		if (vgc === "stopped") {
			problems.push("The Vanguard service (vgc) is stopped.")
			advice.push("Reboot Windows, then start League before anything else.")
		}
	}

	if (problems.length === 0) {
		// Deliberately not "Vanguard is fine". Both services report RUNNING in the most common
		// failure of all — a post-update reboot that Vanguard is silently waiting on.
		advice.push(
			"Both Vanguard services report running, so nothing is provably wrong here — but that does not rule Vanguard out.",
			"If League still will not start or closes itself seconds after launch, reboot Windows: Vanguard demands one after it updates and does not always say so.",
			"If a VAN-#### error appeared, note the number — VAN-1067 means Secure Boot or TPM 2.0 is off in BIOS, and VAN-152 means a reboot is required.",
			"Otherwise, start the League client and leave it at the lobby."
		)
	}

	return { vgk, vgc, probed: true, problems, advice }
}
