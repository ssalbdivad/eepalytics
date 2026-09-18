/**
 * What the coach may say about a matchup, and the words for it.
 *
 * ## The problem this file solves
 *
 * Champ select is the one coaching surface where **nothing has happened yet**. There are no
 * metrics, no moments and no timestamps, so every guardrail the review pass leans on — cite the
 * number, copy the baseline, name the zone — has nothing to bite on. That does not make the
 * fence looser. It makes it the only thing standing between "here's the plan" and a paragraph of
 * confident matchup lore invented on the spot.
 *
 * So the rule is inverted from the review's. In a review the coach may say anything it can cite.
 * Here the coach may say **only the handful of things the client actually published** — the
 * champions, the declared positions, the summoner spells — plus a plan whose shape comes from
 * `knowledge/champions/`, and nothing else at all.
 *
 * ## The fence, same as everywhere
 *
 * Champion notes shape the framing. They never become a stat, a prediction, or a claim about
 * what the enemy will do. If the notes and the published data disagree, the data wins. Notes are
 * absorbed, never quoted or attributed — "the guide says" is not a thing the coach says.
 *
 * ## Runes, items, spell timers — structurally impossible, not merely discouraged
 *
 * - **Enemy runes are not available pre-game from any endpoint.** Not the gameflow session, not
 *   champ select. His own are readable via `/lol-perks/v1/pages` and are deliberately not loaded,
 *   because a coach that discusses one side's runes and invents the other's is worse than one
 *   that discusses neither.
 * - **Items do not exist yet.** Nobody has bought one, and the post-game timeline this app reads
 *   has no purchases at all (see `AGENTS.md`), so a build claim could never be checked later even
 *   in principle.
 * - **Summoner spell timers do not exist.** Which spells were taken is published; whether one is
 *   up is not, and will not be at any point in the game either.
 *
 * `MatchupBrief` has no field for any of the three, which is the real enforcement.
 * `unsupportedMatchupClaims()` below is a coarse second net over the model's own words.
 *
 * PURE and browser-safe: the pre-game turn is assembled wherever the socket lives.
 */

import type { MatchupBrief, MatchupPlayer } from "./schema/api.ts"
import { ROLE_LABELS } from "./schema/domain.ts"

/**
 * Five lines that are allowed, in his real matchup: Lillia jungle into Trundle jungle, both on
 * Flash + Smite, which is what the live client returned on the probe this was built from.
 *
 * These are shipped as data rather than prose so `matchup-prompt.test.ts` can hold them to
 * `unsupportedMatchupClaims()`. A demonstration the guard would itself reject is worse than no
 * demonstration, and prose in a template drifts away from the checker silently.
 */
export const ALLOWED_MATCHUP_LINES: readonly string[] = [
	"Trundle, jungle, Smite and Flash. He's the guy who wants the even early fight, so the plan is to not be there for it.",
	"Lillia into Trundle: your clear gets faster the longer it runs, so full clear and let him have the coin flips — get to six with camps in the bank.",
	"Nobody declared positions this queue, so I'm calling Trundle their jungler off the Smite. Treat that as a strong guess, not a fact.",
	"You took Flash and Smite, so did he — that tells you what got picked and nothing whatsoever about either of you. Path off vision.",
	"This is a plan, not a prediction. First clear, scuttle, level six, then decide. Come back at ten minutes and I'll have actual numbers for you."
]

/** Five that are not, each with the reason it is out. Same matchup, so the contrast is exact. */
export const BANNED_MATCHUP_LINES: readonly { line: string; why: string }[] = [
	{
		line: "He's running Conqueror with Bone Plating, so bait the ult.",
		why: "enemy runes do not exist in any data this app can read, so every word of that was invented"
	},
	{
		line: "Rush Liandry's into his health stacking.",
		why: "an item recommendation; nothing has been bought, and nothing in this app will ever tell you what was"
	},
	{
		line: "His Flash will be down after he burns it on the invade.",
		why: "a summoner spell timer plus an event that has not happened, which is two fabrications in one sentence"
	},
	{
		line: "Lillia is about 46% into Trundle, so play safe.",
		why: "a fabricated statistic; there is no matchup win-rate table here, and a sourceless number sounds exactly like a real one"
	},
	{
		line: "Your bot lane picked that? You're already down a lane.",
		why: "blames a teammate for a game that has not started, and turns a draft into a verdict"
	}
]

/** "Lillia (jungle, Flash + Smite)". Names only — an id is not something you can say out loud. */
const describe = (p: MatchupPlayer): string => {
	const champion = p.champion === "" ? "an unnamed champion" : p.champion
	const bits: string[] = []
	if (p.role !== "UNKNOWN") bits.push(ROLE_LABELS[p.role].toLowerCase())
	if (p.spells.length > 0) bits.push(p.spells.join(" + "))
	return bits.length > 0 ? `${champion} (${bits.join(", ")})` : champion
}

const roster = (players: readonly MatchupPlayer[]): string =>
	players.length === 0 ? "not published" : players.map(describe).join(" · ")

/**
 * The pre-game section, ready to drop into a system prompt or a text-only turn.
 *
 * Deliberately one block: the facts, then the fence, then the examples. The examples are doing
 * most of the work — a rule stated abstractly ("do not invent") loses to a demonstration of the
 * exact sentence that breaks it.
 */
export const matchupPromptSection = (brief: MatchupBrief): string => {
	const you = brief.you
	const opp = brief.opponent

	const basisLine =
		opp === null ?
			"**No enemy counterpart was identified.** Coach the comp and the plan; there is no matchup to talk about."
		: brief.opponentBasis === "smite" ?
			`Their counterpart was identified by **Smite alone** — nobody declared a position in this queue. That has been right in every game measured, but it is still an inference: say "looks like" rather than asserting it.`
		:	"Their counterpart declared the same position, so this pairing is as solid as anything here gets."

	return `## THE GAME ABOUT TO START — ${brief.phase}

Nothing has happened yet. There are no metrics, no moments and no timestamps, so there is
nothing to grade and nothing to cite. The only useful output is **the plan for the first ten
minutes**, and it has to be built from the short list of things the client actually published.

**You:** ${describe(you)}
**Them, in your position:** ${opp ? describe(opp) : "not identified"}
${basisLine}

**Your team:** ${roster(brief.allies)}
**Their team:** ${roster(brief.enemies)}${brief.queue ? `\n**Queue:** ${brief.queue}` : ""}

### That list above is the whole of what is known

Champions, declared positions, summoner spells. That is it. Everything else about this game is
in the future, and the future is not evidence.

**You may never assert a rune, an item, or a summoner spell timer.**

- **Runes.** Enemy runes are not published by any pre-game endpoint — not the gameflow session,
  not champ select, nowhere. You do not know them and you will not know them. Do not name one,
  do not guess a keystone, do not reason from one.
- **Items.** Nobody has bought anything. The app's own post-game timeline carries no purchases
  either, so a build claim could not be checked even after the game. Do not recommend a build,
  a first back, a rush or a boot.
- **Spell timers.** You know *which* spells were taken, because they are on the list. You do not
  know whether any of them is up, and you never will — no data source in this app tracks a
  summoner spell cooldown. "He has Flash" is a fact. "His Flash is down" is a fabrication.

If one of those three is the natural thing to say, say the data isn't there and pivot to
something on the list. Refusing to invent is part of the bit.

### Champion context is for the PLAN, never for the facts

Any champion notes below come from editable markdown and were **not measured from anything**.
Same fence as a review:

- They shape **what he should try to do**. A plan that fits the champion beats a generic one.
- They **never** become a number, a prediction, or a claim about what the enemy will do.
- If they disagree with what the client published, **the client wins.**
- Absorb them. Never quote them, never attribute them, never say "the guide says".
- If there are no notes for a champion, coach the **role** and say nothing about the kit.
  Improvising champion knowledge to fill the gap is the same failure as inventing a stat.

### Nothing here is a prediction

You are not forecasting the game. No win probabilities, no "you lose this matchup", no
percentages — a percentage reads as a measurement and there is no measurement behind it. Give
him a plan he can execute in the first clear, and be honest that the numbers arrive afterwards.

Never turn a matchup into a verdict on him or on a teammate. A hard pick opposite him is a thing
to plan around, not a reason the game is lost, and his teammates' picks are not his to fix.

### Allowed — say things like this

${ALLOWED_MATCHUP_LINES.map((l, i) => `${i + 1}. "${l}"`).join("\n")}

### Banned — never say things like this

${BANNED_MATCHUP_LINES.map((b, i) => `${i + 1}. "${b.line}" — ${b.why}.`).join("\n")}

### Length

Two or three sentences. He is reading this on a loading screen with about forty seconds left.
One plan he can act on beats four observations he cannot.${
		brief.championNotes ?
			`\n\n### ${brief.championNotes.champion} — how the champion works (FETCHED, not measured from a game)\n\n${brief.championNotes.text}`
		:	""
	}${
		brief.opponentNotes ?
			`\n\n### ${brief.opponentNotes.champion} — what he is up against (FETCHED, not measured from a game)\n\nSame fence. This is for shaping his plan, not for asserting what that player is going to do.\n\n${brief.opponentNotes.text}`
		:	""
	}${
		brief.unknowns.length > 0 ?
			`\n\n### What this brief could NOT establish\n\n${brief.unknowns.map(u => `- ${u}`).join("\n")}`
		:	""
	}
`
}

/* ===================================================== the second net */

/**
 * Summoner spells by name, for detection only.
 *
 * This list exists so we can spot the coach putting a *timer* on a spell. It is never used to
 * name a spell to the user — that comes from the client, via `daemon/spells.ts` — so an entry
 * missing here costs a false negative and nothing else.
 */
const SPELL_WORDS =
	"flash|smite|teleport|ignite|heal|barrier|exhaust|ghost|cleanse|clarity|mark|snowball"

/** Words that turn "he has Flash" into "his Flash is up", which we cannot know. */
const TIMER_WORDS =
	"up|down|back|burned|blown|used|available|cooldown|cd|off cooldown|on cooldown|\\d+\\s*(?:s|sec|secs|seconds)"

const CHECKS: readonly { re: RegExp; why: string }[] = [
	{
		re: /\b(runes?|keystone|keystones)\b/i,
		why: "mentions runes — enemy runes are not published by any pre-game endpoint"
	},
	{
		re: /\b(items?|itemi[sz]ation|boots|build (?:order|path)|first back)\b/i,
		why: "mentions items or a build — nothing has been bought and the app never sees purchases"
	},
	{
		// A spell name and an availability word close together. The window is deliberately tight:
		// "he has Flash and Smite, and the game hasn't started" must not trip it.
		re: new RegExp(`\\b(?:${SPELL_WORDS})\\b[^.!?]{0,24}\\b(?:${TIMER_WORDS})\\b`, "i"),
		why: "puts a timer on a summoner spell — no data source in this app tracks a spell cooldown"
	},
	{
		re: /\b\d{1,3}(?:\.\d+)?\s*%/,
		why: "cites a percentage — there is no matchup win-rate table behind it"
	}
]

/**
 * Reasons a pre-game line should not be spoken, or an empty array.
 *
 * **This is a net, not a guarantee.** It cannot recognise an item by its name, and it will
 * occasionally flag a harmless sentence. Both errors are cheap: the guarantee is that
 * `MatchupBrief` has no field carrying runes, items or cooldowns, and silence is already the
 * default posture of the live coach — a dropped line costs nothing, a fabricated one costs the
 * credibility of every line after it.
 *
 * Callers on the pre-game path should drop any line this returns reasons for.
 */
export const unsupportedMatchupClaims = (text: string, brief?: MatchupBrief): string[] => {
	const reasons = CHECKS.filter(c => c.re.test(text)).map(c => c.why)
	const names = unpermittedNames(text, brief)
	if (names.length > 0)
		reasons.push(
			`names something this app has no data for (${names.join(", ")}) — pre-game, the only named things that exist are the champions and summoner spells the client published`
		)
	return reasons
}

/* ------------------------------------------------- proper nouns by name */

/**
 * The word-level checks above cannot see a rune or an item that is named rather than described.
 * "He's running Conqueror" contains no banned vocabulary at all, and it is the single likeliest
 * fabrication on this surface.
 *
 * So the rule is inverted here, the same way the rest of the pre-game fence is inverted: **a
 * capitalised word mid-sentence is unsupported unless it is one of the few things that provably
 * exist.** Those are the champions and summoner spells the client published for THIS game, plus
 * neutral map and objective vocabulary, plus the T1 rotation the persona is built on.
 *
 * A rune name is not on that list. Neither is an item. Neither is a champion who is not in this
 * game — "he'll play it like a Rek'Sai" is a claim about a player, not about the data.
 *
 * The failure mode is a false positive on some proper noun nobody thought of, which costs one
 * dropped line. The alternative failure mode is a confidently named rune, which costs the
 * credibility of everything said afterwards. Those are not close.
 */
const NEUTRAL_NAMES = new Set(
	[
		// map and objectives
		"baron", "nashor", "drake", "dragon", "elder", "herald", "grubs", "voidgrubs", "atakhan",
		"scuttle", "rift", "river", "pit", "fountain", "nexus", "inhibitor", "turret", "tower",
		"blue", "red", "gromp", "krugs", "raptors", "wolves", "buff", "crab",
		// lanes and roles
		"top", "mid", "bot", "bottom", "jungle", "support", "adc",
		// the persona's own rotation
		"faker", "oner", "keria", "gumayusi", "doran", "t1", "lck",
		// pronoun-shaped capitals
		"i", "i'll", "i'm", "i've", "i'd"
	].map(s => s.toLowerCase())
)

/** Capitalised tokens that open a sentence carry no information — every sentence starts with one. */
const MID_SENTENCE_CAPITAL = /(?<![.!?]\s|^|["“'(\n])\b([A-Z][A-Za-z'’]+)\b/g

const unpermittedNames = (text: string, brief?: MatchupBrief): string[] => {
	const permitted = new Set(NEUTRAL_NAMES)
	if (brief) {
		for (const p of [brief.you, brief.opponent, ...brief.allies, ...brief.enemies]) {
			if (!p) continue
			// A champion name can be two words ("Lee Sin", "Twisted Fate"); permit each part, since
			// the scan is token by token.
			for (const word of p.champion.split(/[^A-Za-z'’]+/)) if (word) permitted.add(word.toLowerCase())
			for (const spell of p.spells)
				for (const word of spell.split(/[^A-Za-z'’]+/)) if (word) permitted.add(word.toLowerCase())
		}
	} else {
		// With no brief there is no per-game truth to check against, so the generic spell names
		// stand in. This path is for callers that only have a sentence.
		for (const spell of SPELL_WORDS.split("|")) permitted.add(spell)
	}

	const out: string[] = []
	for (const m of text.matchAll(MID_SENTENCE_CAPITAL)) {
		const word = m[1]!
		const lower = word.toLowerCase()
		// A possessive is the same noun: "Oner's route" is permitted exactly when "Oner" is, and
		// "Liandry's" is unpermitted exactly as "Liandry" would be.
		const bare = lower.replace(/['’]s$/, "")
		if (permitted.has(lower) || permitted.has(bare)) continue
		if (!out.includes(word)) out.push(word)
	}
	return out
}
