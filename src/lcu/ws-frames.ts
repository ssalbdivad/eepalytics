/**
 * The websocket wire format, by hand, for the LCU's WAMP feed.
 *
 * ## Why hand-rolled rather than the global `WebSocket`
 * The LCU serves `wss://127.0.0.1:<port>` with a self-signed Riot certificate. Node's global
 * `WebSocket` gives no per-connection TLS knob — the only way to accept that certificate is
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`, which is process-wide and would also disable verification
 * for the Anthropic and Gemini calls this same process makes. `https.request` + the `upgrade`
 * event hands back a raw socket whose TLS settings are scoped to that one connection, so the
 * handshake has to be performed here.
 *
 * ## Why this is a second copy of logic that exists in `bridge/bridge.mjs`
 * It is deliberate, not drift. `bridge.mjs` is executed by a **Windows** `node.exe` that is
 * handed nothing but a file path: it must stay a standalone `.mjs` importing only node
 * builtins, because it cannot resolve this project's `.ts` sources. This module is the
 * in-process copy used by `LcuDirect`, and unlike the bridge's it is unit-tested — the frame
 * reader is the part that fails silently when it is wrong.
 */

import crypto from "node:crypto"

/** RFC 6455 §1.3. Concatenated with the client key to derive `Sec-WebSocket-Accept`. */
export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

export const WS_OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa
} as const

/** Refuse absurd frames outright — a length field we cannot trust is a protocol bug. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024

export interface WsFrame {
	fin: boolean
	opcode: number
	payload: Buffer
	/** Bytes of the input this frame occupied. The caller slices them off and loops. */
	consumed: number
}

/** A fresh 16-byte `Sec-WebSocket-Key`, base64. */
export const newWsKey = (): string => crypto.randomBytes(16).toString("base64")

/** The `Sec-WebSocket-Accept` the server must echo for `key`. Mismatch means a wrong peer. */
export const acceptKeyFor = (key: string): string =>
	crypto
		.createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64")

/**
 * Read one frame off the front of `buf`.
 *
 * Returns `null` when the buffer holds only part of a frame — TCP splits wherever it likes, so
 * every branch that reads a length field has to re-check the length first. Throws only for a
 * frame claiming more than `MAX_FRAME_BYTES`.
 */
export const readFrame = (buf: Buffer, maxBytes = MAX_FRAME_BYTES): WsFrame | null => {
	if (buf.length < 2) return null
	const first = buf[0] as number
	const second = buf[1] as number
	const fin = (first & 0x80) !== 0
	const opcode = first & 0x0f
	const masked = (second & 0x80) !== 0
	let len = second & 0x7f
	let off = 2
	if (len === 126) {
		if (buf.length < 4) return null
		len = buf.readUInt16BE(2)
		off = 4
	} else if (len === 127) {
		if (buf.length < 10) return null
		const big = buf.readBigUInt64BE(2)
		if (big > BigInt(maxBytes)) throw new Error(`websocket frame too large: ${big}`)
		len = Number(big)
		off = 10
	}
	if (len > maxBytes) throw new Error(`websocket frame too large: ${len}`)
	let mask: Buffer | null = null
	if (masked) {
		if (buf.length < off + 4) return null
		mask = buf.subarray(off, off + 4)
		off += 4
	}
	if (buf.length < off + len) return null
	let payload = buf.subarray(off, off + len)
	if (mask) {
		// Copy before un-masking: `subarray` shares memory with the caller's buffer and the
		// caller still owns the bytes behind it.
		const copy = Buffer.from(payload)
		for (let i = 0; i < copy.length; i++)
			copy[i] = (copy[i] as number) ^ (mask[i % 4] as number)
		payload = copy
	}
	return { fin, opcode, payload, consumed: off + len }
}

/**
 * Encode one FIN frame.
 *
 * `mask` exists for the tests and for the direction rule: client-to-server frames MUST be
 * masked (RFC 6455 §5.3) and server-to-client frames MUST NOT be. Pass `null` to send an
 * unmasked frame; omit it and a random mask is generated, which is what a client wants.
 */
export const encodeFrame = (
	opcode: number,
	payload: Buffer,
	mask: Buffer | null = crypto.randomBytes(4)
): Buffer => {
	const len = payload.length
	let header: Buffer
	if (len < 126) {
		header = Buffer.alloc(2)
		header[1] = len
	} else if (len < 65536) {
		header = Buffer.alloc(4)
		header[1] = 126
		header.writeUInt16BE(len, 2)
	} else {
		header = Buffer.alloc(10)
		header[1] = 127
		header.writeBigUInt64BE(BigInt(len), 2)
	}
	header[0] = 0x80 | opcode
	if (!mask) return Buffer.concat([header, payload])
	header[1] = (header[1] as number) | 0x80
	const body = Buffer.from(payload)
	for (let i = 0; i < body.length; i++) body[i] = (body[i] as number) ^ (mask[i % 4] as number)
	return Buffer.concat([header, mask, body])
}
