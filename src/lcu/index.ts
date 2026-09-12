/**
 * The LCU unit's public surface, plus the factory everything else should use.
 *
 * ```ts
 * const lcu = await createLcu(settings)     // bridge if possible, curl if not
 * const phase = await lcu.client.gameflowPhase()
 * lcu.on("lcu-event", e => …)               // bridge only; curl emits none
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
import { LiveClient } from "./live-client.ts"
import type { LcuEventMessage, LcuTransport, TransportKind, TransportState } from "./transport.ts"

export * from "./transport.ts"
export * from "./lockfile.ts"
export * from "./bridge-client.ts"
export * from "./curl-fallback.ts"
export * from "./client.ts"
export * from "./live-client.ts"

export interface CreateLcuOptions extends LcuClientOptions {
	/** Force a transport. Defaults to `settings.transport`. */
	transport?: TransportKind
	bridge?: LcuBridgeOptions
	/** Where transport diagnostics go. */
	onLog?: (line: string) => void
}

/**
 * A started transport plus the two typed clients that sit on it.
 *
 * `kind` tells you which transport actually won, which matters for the health endpoint: the
 * curl fallback works but is ~38x slower and delivers **no LCU websocket events**, so anything
 * relying on push has to fall back to polling.
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
 * Start the fastest transport that works here, and never fail just because the bridge cannot
 * run. Order: the bridge (p50 2.3 ms, websocket events) unless `transport: "curl"` is
 * configured or Windows has no `node.exe`; then curl (~88 ms, no events).
 *
 * Note that BOTH transports start happily with the League client closed — that is the
 * `degraded` state, not a failure. Only "no way to reach Windows at all" throws.
 */
export const createLcu = async (
	settings: Partial<Settings> = {},
	opts: CreateLcuOptions = {}
): Promise<Lcu> => {
	const preferred = opts.transport ?? settings.transport ?? DEFAULT_SETTINGS.transport
	const log = opts.onLog ?? ((line: string) => console.error(line))
	let fallbackReason: string | null = null

	if (preferred === "bridge") {
		const nodeExe = await findWindowsNode(opts.bridge?.nodeExe)
		if (!nodeExe) {
			fallbackReason = "no Windows node.exe found; using curl.exe (~88ms/request, no LCU events)"
			log(`[lcu] ${fallbackReason}`)
		} else {
			const bridge = new LcuBridge({ onLog: log, ...opts.bridge, nodeExe })
			try {
				await bridge.start()
				return build(bridge, opts, null)
			} catch (err) {
				fallbackReason = `bridge failed to start (${String(err)}); using curl.exe`
				log(`[lcu] ${fallbackReason}`)
				await bridge.stop().catch(() => {})
			}
		}
	}

	const curl = new LcuCurl({ onLog: log })
	await curl.start()
	return build(curl, opts, fallbackReason)
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
