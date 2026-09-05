/**
 * Which champion the coach's prompt is built for, BEFORE the game exists.
 *
 * This file exists because of one gap in the wiring, and it is the gap that would have shipped
 * silently. The socket sets its system prompt ONCE, in `POST /api/live/gemini/token`, and that
 * call happens at champion select — minutes before the live client on :2999 answers anything. A
 * prompt built from `allgamedata` alone would therefore ship every socket session with no champion
 * knowledge in it, while the turn-based path (which builds its prompt per turn, in a game) got the
 * clauses. Two architectures, one coach, silently different prompts — and nothing would have said
 * so, because "no notes on file" is a supported, invisible state.
 *
 * The sessions here are the shape the client really returns, copied from `analysis/matchup.test.ts`
 * so both tests are wrong together or right together. Ids are real (Lillia 876, Trundle 48) and
 * every NAME comes from an injected lookup, exactly as at runtime: nothing here hardcodes a name
 * table, because the app does not either.
 */

import { strictEqual } from "node:assert/strict"
import { describe, test } from "node:test"
import { championFromSession } from "./live.ts"
import type { GameflowSession } from "../../shared/schema/lcu.ts"

const ME = "188dee22-18d6-5752-ba7f-b69cf3d2506e"
const CHAMPIONS: Record<number, string> = { 876: "Lillia", 48: "Trundle", 64: "Lee Sin" }
const nameOf = (id: number): string => CHAMPIONS[id] ?? ""

interface Seat {
	puuid: string
	championId: number
	position: string
}

const session = (
	mine: readonly Seat[],
	theirs: readonly Seat[],
	opts: { phase?: string; withSelections?: boolean } = {}
): GameflowSession =>
	({
		phase: opts.phase ?? "ChampSelect",
		gameData: {
			gameId: 5635467422,
			teamOne: mine.map(s => ({
				puuid: s.puuid,
				championId: s.championId,
				selectedPosition: s.position
			})),
			teamTwo: theirs.map(s => ({
				puuid: s.puuid,
				championId: s.championId,
				selectedPosition: s.position
			})),
			...(opts.withSelections === false ?
				{}
			:	{
					playerChampionSelections: [...mine, ...theirs].map(s => ({
						puuid: s.puuid,
						championId: s.championId,
						spell1Id: 4,
						spell2Id: 11
					}))
				})
		}
	}) as GameflowSession

const ME_JUNGLE: Seat = { puuid: ME, championId: 876, position: "JUNGLE" }
const THEM_JUNGLE: Seat = { puuid: "enemy-jg", championId: 48, position: "JUNGLE" }

describe("the champion the socket's prompt is built for", () => {
	test("is known at champion select, which is the whole point", () => {
		strictEqual(championFromSession(session([ME_JUNGLE], [THEM_JUNGLE]), nameOf), "Lillia")
	})

	test("is still known on the loading screen, where champ select's own endpoint has gone", () => {
		// `/lol-champ-select/v1/session` 404s with "No active delegate" the moment the draft ends.
		// The gameflow session keeps publishing the roster, which is why it is the source here.
		const s = session([ME_JUNGLE], [THEM_JUNGLE], { phase: "GameStart" })
		strictEqual(championFromSession(s, nameOf), "Lillia")
	})

	test("reads the SELECTION, not the roster row, so a swap during the draft is followed", () => {
		const s = session([ME_JUNGLE], [THEM_JUNGLE])
		// The roster rows lag a swap; the selections carry the later truth. See `matchup.ts`.
		s.gameData!.playerChampionSelections = [{ puuid: ME, championId: 64, spell1Id: 4, spell2Id: 11 }]
		strictEqual(championFromSession(s, nameOf), "Lee Sin")
	})

	test("is empty before he locks, rather than the first champion on the roster", () => {
		const s = session([{ puuid: ME, championId: 0, position: "JUNGLE" }], [THEM_JUNGLE], {
			withSelections: false
		})
		strictEqual(championFromSession(s, nameOf), "")
	})

	test("is empty for an id no name table knows — a wrong kit is worse than no kit", () => {
		const s = session([{ puuid: ME, championId: 9999, position: "JUNGLE" }], [THEM_JUNGLE])
		strictEqual(championFromSession(s, nameOf), "")
	})

	test("is empty in the lobby and after the game, where there is nothing to coach", () => {
		for (const phase of ["None", "Lobby", "Matchmaking", "EndOfGame"])
			strictEqual(championFromSession(session([ME_JUNGLE], [THEM_JUNGLE], { phase }), nameOf), "")
	})

	test("is empty when the rosters do not contain his puuid — nothing there is his", () => {
		const s = session([{ puuid: "someone-else", championId: 876, position: "JUNGLE" }], [THEM_JUNGLE])
		strictEqual(championFromSession(s, nameOf), "")
	})
})
