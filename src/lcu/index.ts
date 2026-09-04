/**
 * The LCU unit's public surface, plus the factory everything else should use.
 *
 * ```ts
 * const lcu = await createLcu(settings)     // the fastest transport that works on this host
 * const phase = await lcu.client.gameflowPhase()
 * lcu.on("lcu-event", e => …)               // bridge + direct; curl emits none
 * await lcu.stop()
 * ```
 */

import { EventEmitter } from "node:events"
import { DEFAULT_SETTINGS } from "../shared/schema/settings.ts"
import type { Settings } from "../shared/schema/settings.ts"
import { LcuBridge, findWindowsNode } from "./bridge-client.ts"
import type { LcuBridgeOptions } from "./bridge-client.ts"
import { LcuClient } from "./client.ts"
import type { LcuClientOptions } from "./client.ts"
import { LcuCurl } from "./curl-fallback.ts"
import { LcuDirect, probeDirect } from "./direct.ts"
import type { LcuDirectOptions } from "./direct.ts"
import { describeEnvironment, detectEnvironment } from "./environment.ts"
import type { EnvironmentFacts } from "./environment.ts"
import { LiveClient } from "./live-client.ts"
import { describePlan, planTransports } from "./select.ts"
import type { TransportChoice } from "./select.ts"
import { LcuTransportError } from "./transport.ts"
import type { LcuEventMessage, LcuTransport, TransportKind, TransportState } from "./transport.ts"

export * from "./transport.ts"
export * from "./lockfile.ts"
export * from "./bridge-client.ts"
export * from "./curl-fallback.ts"
export * from "./direct.ts"
export * from "./environment.ts"
export * from "./select.ts"
export * from "./client.ts"
export * from "./live-client.ts"
export * from "./replay-schema.ts"

export interface CreateLcuOptions extends LcuClientOptions {
	/** Force a transport. Defaults to `settings.transport`. */
	transport?: TransportKind
	bridge?: LcuBridgeOptions
	direct?: LcuDirectOptions
	/** Override host detection. Tests pass this; nothing else should need to. */
	environment?: EnvironmentFacts
	/** Where transport diagnostics go. */
	onLog?: (line: string) => void
}

/**
 * A started transport plus the two typed clients that sit on it.
 *
 * `kind` tells you which transport actually won, which matters for the health endpoint: the
 * curl fallback works but is ~38x slower and delivers **no LCU websocket events**, so anything
 * relying on push has to fall back to polling. `bridge` and `direct` both carry events.
 */
export interface Lcu extends EventEmitter {
	readonly kind: TransportKind
	readonly state: TransportState
	readonly transport: LcuTransport
	readonly client: LcuClient
	readonly live: LiveClient
	/** Why we are not on the bridge, when we are not. */
	readonly fallbackReason: string | null
	stop(): Promise<void>
	on(event: "lcu-event", cb: (e: LcuEventMessage) => void): this
	on(event: "state", cb: (s: TransportState) => void): this
	on(event: string, cb: (...args: any[]) => void): this
}

class LcuHandle extends EventEmitter implements Lcu {
	readonly kind: TransportKind
	readonly transport: LcuTransport
	readonly client: LcuClient
	readonly live: LiveClient
	readonly fallbackReason: string | null

	constructor(
		transport: LcuTransport,
		client: LcuClient,
		live: LiveClient,
		fallbackReason: string | null
	) {
		super()
		this.kind = transport.kind
		this.transport = transport
		this.client = client
		this.live = live
		this.fallbackReason = fallbackReason
		this.on("error", () => {})
		transport.on("state", (s: TransportState) => this.emit("state", s))
		transport.on("lcu-event", (e: LcuEventMessage) => this.emit("lcu-event", e))
		transport.on("lockfile", (lf: unknown) => this.emit("lockfile", lf))
		transport.on("error", (err: Error) => this.emit("error", err))
	}

	get state(): TransportState {
		return this.transport.state
	}

	async stop(): Promise<void> {
		await this.transport.stop()
	}
}

/**
 * Start the fastest transport that works **here**, and never fail just because one of them
 * cannot run on this host.
 *
 * The order is chosen by `planTransports` from evidence about the environment, not from a
 * platform string alone (see `select.ts` and `environment.ts`), and each candidate is *tried*:
 * a transport that starts is proof, and the next one down is used when it does not. On this
 * WSL machine that reproduces the previous behaviour exactly — bridge, then curl — because
 * `direct` sits behind a loopback probe that WSL2's NAT networking refuses.
 *
 * Note that every transport starts happily with the League client closed — that is the
 * `degraded` state, not a failure. Only "no way to reach the client at all" throws, and it
 * throws with the last candidate's own error rather than a summary.
 */
export const createLcu = async (
	settings: Partial<Settings> = {},
	opts: CreateLcuOptions = {}
): Promise<Lcu> => {
	const preferred = opts.transport ?? settings.transport ?? DEFAULT_SETTINGS.transport
	const log = opts.onLog ?? ((line: string) => console.error(line))
	const facts = opts.environment ?? detectEnvironment()
	const plan = planTransports(preferred, facts)
	log(`[lcu] host ${describeEnvironment(facts)}`)
	log(`[lcu] transport plan: ${describePlan(plan)}`)

	const notes: string[] = []
	let lastError: unknown = null

	for (const choice of plan) {
		let transport: LcuTransport | null = null
		try {
			transport = await startCandidate(choice, opts, log, notes)
		} catch (err) {
			lastError = err
			notes.push(`${choice.kind} failed to start (${String(err)})`)
			log(`[lcu] ${notes[notes.length - 1]}`)
			continue
		}
		if (!transport) continue
		if (choice.kind === "curl")
			log("[lcu] on curl: no LCU websocket events, so gameflow changes come from polling")
		return build(transport, opts, notes.length > 0 ? notes.join("; ") : null)
	}

	throw (
		lastError ??
		new LcuTransportError(
			"SPAWN_FAILED",
			`no usable LCU transport on this host (${describeEnvironment(facts)}); tried ${describePlan(plan)}`
		)
	)
}

/**
 * Start one candidate, or return `null` when it is not usable here.
 *
 * `null` means "skip, for a reason already written into `notes`" — a missing `node.exe`, or a
 * direct probe that could not prove anything. A throw means the transport exists and refused,
 * which is worth reporting to the caller if nothing else works.
 */
const startCandidate = async (
	choice: TransportChoice,
	opts: CreateLcuOptions,
	log: (line: string) => void,
	notes: string[]
): Promise<LcuTransport | null> => {
	if (choice.kind === "bridge") {
		const nodeExe = await findWindowsNode(opts.bridge?.nodeExe)
		if (!nodeExe) {
			notes.push("no Windows node.exe found; using curl.exe (~88ms/request, no LCU events)")
			log(`[lcu] ${notes[notes.length - 1]}`)
			return null
		}
		const bridge = new LcuBridge({ onLog: log, ...opts.bridge, nodeExe })
		try {
			await bridge.start()
			return bridge
		} catch (err) {
			await bridge.stop().catch(() => {})
			throw err
		}
	}

	if (choice.kind === "curl") {
		const curl = new LcuCurl({ onLog: log })
		await curl.start()
		return curl
	}

	// `direct`. When the plan wants proof, one refused request is the difference between
	// "the loopback reaches the client" and "we are on WSL and it never will".
	if (choice.requireProof) {
		const probe = await probeDirect({ lockfilePath: opts.direct?.lockfilePath })
		log(`[lcu] direct probe: ${probe.verdict} — ${probe.detail} (${probe.durationMs}ms)`)
		if (probe.verdict !== "reachable") {
			notes.push(`direct not proved reachable (${probe.verdict}: ${probe.detail})`)
			return null
		}
	}
	const direct = new LcuDirect({ onLog: log, ...opts.direct })
	await direct.start()
	return direct
}

const build = (
	transport: LcuTransport,
	opts: CreateLcuOptions,
	fallbackReason: string | null
): Lcu =>
	new LcuHandle(
		transport,
		new LcuClient(transport, opts),
		new LiveClient(transport, { onWarn: opts.onWarn ? msg => opts.onWarn?.(msg) : undefined }),
		fallbackReason
	)
