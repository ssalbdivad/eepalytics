/**
 * Where are we running, and can a socket opened here actually reach the League client?
 *
 * This exists to pick a transport with evidence instead of a guess. The answer decides
 * whether `createLcu` reaches for the Windows interop transports (`bridge`, `curl`) or for
 * `LcuDirect`, and getting it wrong on someone else's machine looks like "the app cannot see
 * my client" with nothing in the log to explain it.
 *
 * ## Why several signals and not one
 * Every individual WSL marker is defeatable:
 *
 * - `/proc/version` is the classic check, but it is a *file* — a container image can carry a
 *   stale one, and it says nothing on a distro whose kernel was rebuilt.
 * - `WSL_DISTRO_NAME` / `WSL_INTEROP` are real and reliable in an interactive shell, and
 *   absent from a `systemd --user` unit's environment on some setups. This app *ships* as a
 *   systemd unit (see `systemd/`), so a detector that leaned on them alone would misfire in
 *   exactly the configuration it runs in.
 * - `/mnt/c` is a mount, and any Linux box can have one.
 *
 * So we collect all of them, treat any single hit as enough to say "WSL", and keep the list of
 * what fired so the daemon log can say *why* it chose a transport. The pure function is
 * separated from the file reads so the interesting cases can be tested without a WSL kernel.
 *
 * ## What this does NOT decide
 * It does not decide that `fetch` will work. Even a confident "not WSL" is only an argument;
 * WSL2 in *mirrored* networking mode can reach Windows' loopback, and a native Windows box with
 * the client closed cannot. Proof is a request that answers — see `LcuDirect.probe`.
 */

import fs from "node:fs"

/** Files whose contents carry a kernel-level WSL marker. */
const KERNEL_FILES = ["/proc/version", "/proc/sys/kernel/osrelease"] as const

/** Paths that only exist under WSL, or that only exist when interop is mounted. */
const WSL_PATHS = ["/run/WSL", "/mnt/wsl", "/mnt/c/Windows"] as const

/** Environment variables WSL sets for processes it launches. */
const WSL_ENV_VARS = ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"] as const

/** The raw observations. Separated from the verdict so tests can supply them directly. */
export interface EnvironmentProbe {
	platform: string
	env: Record<string, string | undefined>
	/** Contents of `/proc/version` and `/proc/sys/kernel/osrelease`, `""` when unreadable. */
	kernelText: string
	/** Which of `WSL_PATHS` exist. */
	presentPaths: readonly string[]
}

export type HostKind = "windows" | "wsl" | "linux" | "mac" | "other"

export interface EnvironmentFacts {
	kind: HostKind
	isWsl: boolean
	/**
	 * Can a Windows helper process be reached at all? Only WSL has `/mnt/c/...curl.exe`,
	 * `wslpath` and interop `node.exe`, so this is what makes `bridge`/`curl` even possible.
	 */
	interopPossible: boolean
	/**
	 * `yes` = this host's loopback IS the client's loopback (native Windows). `unknown` = it
	 * might be (WSL mirrored networking) or the client might not run here at all. Never `no`:
	 * only a request can prove that, and this module does not make requests.
	 */
	directPlausible: "yes" | "unknown"
	/** Every marker that fired, for the log line that explains the choice. */
	signals: string[]
}

/** The verdict, from observations alone. Pure — no I/O, no `process`. */
export const readEnvironment = (probe: EnvironmentProbe): EnvironmentFacts => {
	const signals: string[] = []

	if (probe.platform === "win32") {
		return {
			kind: "windows",
			isWsl: false,
			interopPossible: false,
			directPlausible: "yes",
			signals: ["platform=win32"]
		}
	}

	const kernel = probe.kernelText.toLowerCase()
	if (kernel.includes("microsoft")) signals.push("kernel:microsoft")
	if (kernel.includes("wsl")) signals.push("kernel:wsl")
	for (const name of WSL_ENV_VARS) if (probe.env[name]) signals.push(`env:${name}`)
	for (const path of probe.presentPaths) signals.push(`path:${path}`)

	const isWsl = probe.platform === "linux" && signals.length > 0
	if (isWsl)
		return {
			kind: "wsl",
			isWsl: true,
			interopPossible: true,
			// WSL2's default NAT networking cannot reach Windows' 127.0.0.1 (measured here,
			// twice). Mirrored mode can. Neither is visible from these markers, so: unknown.
			directPlausible: "unknown",
			signals
		}

	const kind: HostKind =
		probe.platform === "darwin" ? "mac"
		: probe.platform === "linux" ? "linux"
		: "other"
	return {
		kind,
		isWsl: false,
		interopPossible: false,
		// Not WSL, so nothing sits between this process and 127.0.0.1. Whether the League
		// client is *there* is a different question, and only a probe answers it.
		directPlausible: "yes",
		signals: [`platform=${probe.platform}`]
	}
}

/** Read the observations off this machine. Cheap: two small files and three `stat`s. */
export const probeEnvironment = (): EnvironmentProbe => {
	const platform = typeof process !== "undefined" ? process.platform : "other"
	const env = typeof process !== "undefined" && process.env ? process.env : {}
	let kernelText = ""
	if (platform !== "win32")
		for (const file of KERNEL_FILES) {
			try {
				kernelText += fs.readFileSync(file, "utf8")
			} catch {
				/* not Linux, or a locked-down /proc — the other signals still apply */
			}
		}
	const presentPaths =
		platform === "win32" ? []
		: WSL_PATHS.filter(path => {
				try {
					fs.accessSync(path)
					return true
				} catch {
					return false
				}
			})
	return { platform, env, kernelText, presentPaths }
}

let cached: EnvironmentFacts | null = null

/** The verdict for this process. Cached: nothing here changes while we are running. */
export const detectEnvironment = (): EnvironmentFacts =>
	(cached ??= readEnvironment(probeEnvironment()))

/** One line for the daemon log: the verdict plus the evidence behind it. */
export const describeEnvironment = (facts: EnvironmentFacts): string =>
	`${facts.kind} (direct ${facts.directPlausible}, interop ${facts.interopPossible ? "available" : "unavailable"}; ${facts.signals.join(", ") || "no markers"})`
