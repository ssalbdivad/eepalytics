/**
 * The websocket frame codec.
 *
 * This is the layer whose bugs are invisible: a mis-read length silently swallows every event
 * that follows it, and the daemon then just... stops hearing about champ select. The bridge has
 * carried an untested copy of this logic for months; this one is tested.
 */

import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict"
import { describe, it } from "node:test"
import { MAX_FRAME_BYTES, WS_OPCODE, acceptKeyFor, encodeFrame, readFrame } from "./ws-frames.ts"

const text = (s: string, mask?: Buffer | null): Buffer =>
	encodeFrame(WS_OPCODE.text, Buffer.from(s), mask === undefined ? null : mask)

describe("acceptKeyFor", () => {
	it("matches the RFC 6455 §1.3 worked example", () => {
		// The one case with a published expected value — if the hash or the GUID is wrong, this
		// is the only test that can tell us before a real client refuses the handshake.
		strictEqual(acceptKeyFor("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
	})
})

describe("readFrame", () => {
	it("round-trips an unmasked server frame", () => {
		const frame = readFrame(text("hello"))
		ok(frame)
		strictEqual(frame!.payload.toString(), "hello")
		strictEqual(frame!.opcode, WS_OPCODE.text)
		strictEqual(frame!.fin, true)
	})

	it("un-masks a masked frame without disturbing the caller's buffer", () => {
		const mask = Buffer.from([1, 2, 3, 4])
		const wire = encodeFrame(WS_OPCODE.text, Buffer.from("hello"), mask)
		const before = Buffer.from(wire)
		const frame = readFrame(wire)
		strictEqual(frame!.payload.toString(), "hello")
		deepStrictEqual(wire, before, "readFrame must not un-mask in place — the bytes are borrowed")
	})

	it("returns null for a partial frame instead of guessing", () => {
		const wire = text("some payload that arrives in two pieces")
		for (const cut of [1, 2, 5, wire.length - 1]) strictEqual(readFrame(wire.subarray(0, cut)), null)
		ok(readFrame(wire))
	})

	it("reads the 126 and 127 length forms", () => {
		for (const size of [125, 126, 200, 65535, 65536, 70000]) {
			const payload = Buffer.alloc(size, 0x61)
			const frame = readFrame(encodeFrame(WS_OPCODE.binary, payload, null))
			ok(frame, `size ${size} did not decode`)
			strictEqual(frame!.payload.length, size)
			strictEqual(frame!.consumed, size < 126 ? size + 2 : size < 65536 ? size + 4 : size + 10)
		}
	})

	it("reports how many bytes it consumed, so a pipelined stream can be drained", () => {
		// Two events in one TCP read is normal; the loop that handles it lives or dies on this.
		const wire = Buffer.concat([text("first"), text("second")])
		const one = readFrame(wire)!
		strictEqual(one.payload.toString(), "first")
		const two = readFrame(wire.subarray(one.consumed))!
		strictEqual(two.payload.toString(), "second")
	})

	it("refuses a frame that claims more than the cap rather than allocating it", () => {
		const header = Buffer.alloc(10)
		header[0] = 0x80 | WS_OPCODE.binary
		header[1] = 127
		header.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1), 2)
		throws(() => readFrame(header), /too large/)
	})

	it("keeps control frames distinguishable, including a zero-length ping", () => {
		const frame = readFrame(encodeFrame(WS_OPCODE.ping, Buffer.alloc(0), null))!
		strictEqual(frame.opcode, WS_OPCODE.ping)
		strictEqual(frame.payload.length, 0)
		strictEqual(frame.consumed, 2)
	})
})

describe("encodeFrame", () => {
	it("masks by default, because client-to-server frames MUST be masked (RFC 6455 §5.3)", () => {
		const wire = encodeFrame(WS_OPCODE.text, Buffer.from("subscribe"))
		strictEqual((wire[1]! & 0x80) !== 0, true)
		strictEqual(readFrame(wire)!.payload.toString(), "subscribe")
	})

	it("sets FIN on every frame it produces", () => {
		strictEqual((text("x")[0]! & 0x80) !== 0, true)
	})
})
