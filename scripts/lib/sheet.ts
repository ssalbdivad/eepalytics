/**
 * sheet — the blinded human grading sheet, as one HTML file he can open from disk and finish.
 *
 * ## Why a file, and why blinded
 *
 * `scripts/blind-judge.ts` already established the load-bearing half of this: a reader shown lines
 * grouped by arm is not judging the lines, he is judging the arm. The label does the work, the
 * fifty sentences under the heading he already believes in read better than the fifty under the
 * one he does not, and the resulting table is his prior with error bars on it. So every line here
 * arrives with an opaque id, in one shuffled list, with NO arm, NO provider, NO model name — and
 * no latency either, because latency is an arm label written in milliseconds: the socket answers
 * in about a second and a turn-based provider takes several, so printing it beside the sentence
 * hands him the grouping he was supposed to be blind to.
 *
 * The reason this is an HTML file rather than the JSON that `blind-judge` emits is narrower and
 * more practical. That JSON was judgeable because its evidence was five lines of text. This run
 * grades lines that were spoken over a SCREENSHOT, and the screenshot is the only channel that can
 * settle whether a sentence about what is on the map was true. A judging pass that cannot see the
 * picture cannot separate `useful` from `unverifiable` on exactly the lines the frame was added
 * for, which is most of what this experiment is about. Hence: one self-contained page, the image
 * big, the block one click away, and a keyboard path fast enough that a hundred and sixty-eight
 * cards is an evening and not a project.
 *
 * Self-contained is literal. No CDN, no font, no fetch, no module — it is opened as `file://`,
 * where every one of those either fails silently or is blocked by CORS, and a grading sheet that
 * renders blank the one night he sits down to grade has cost more than it saved. Everything is
 * inline, and the frames are inlined ONCE and referenced by index, because the same instant is
 * usually spoken over by every arm and a naive render carries each JPEG four to eight times.
 *
 * ## The four verdicts are IMPORTED, not restated
 *
 * `VERDICTS` and the `Verdict` type come from `blind-judge.ts`. Two judging passes over the same
 * project that quietly disagreed about what `generic` means would produce two incomparable rates
 * with the same column headings, which is worse than having only one of them. The definitions, in
 * his words there and repeated on the sheet's own legend:
 *
 *   `useful`        true, specific to this instant, and it names something to DO.
 *   `generic`       true and checkable, and it would read identically in another game or five
 *                   minutes earlier. The failure that is hardest to see in a rate.
 *   `unverifiable`  it may be true and nothing here can check it.
 *   `false`         it contradicts the block, or asserts what no channel in this app knows. The
 *                   only fatal one.
 *
 * The digit keys are best-to-worst (1 useful, 2 generic, 3 unverifiable, 4 false) rather than the
 * worst-first order `VERDICTS` is declared in; the order on screen and the order in the tally are
 * different jobs and only one of them is typed a thousand times.
 *
 * ## What the sheet promises him
 *
 * Grading is stored in `localStorage`, keyed by the RUN (the driver's own output stamp, never the
 * title — see `slug`), so closing the tab is not losing an evening — but `localStorage` is also the one thing on a `file://` page that can be wiped
 * without asking, so the EXPORT control exists in two forms: a download, and the same JSON in a
 * selectable textarea, because a `file://` download is blocked in some browsers and a sheet with
 * only the blocked path is a sheet whose results cannot leave the tab. The textarea reads back in
 * too, so a run graded on one machine can be finished on another.
 *
 * ## Reveal is done by code, once
 *
 * `revealVerdicts` is the only place the key and the verdicts meet. It first checks that the two
 * files name the SAME run and refuses outright when they do not — every sheet numbers its lines
 * `L01…LNN`, so a mismatched pair joins with no id left over and reports rates about sentences
 * nobody graded. Then it joins them, tallies per arm
 * with Wilson 95% intervals, and runs `separated` over every pair — and when two arms do not
 * separate it SAYS SO in the line, in words, rather than leaving two overlapping percentages next
 * to each other for a reader to draw a conclusion from. Ungraded ids are excluded from every
 * denominator and reported as their own number; counting an ungraded line as anything is the
 * cheapest way to manufacture a difference, and n here is small enough that it would work.
 *
 * NODE-safe and browser-safe both: this file reads nothing, writes nothing, and prints nothing. It
 * is a library. The driver (`scripts/bench-stream.ts`) owns the filesystem.
 */

import { VERDICTS, shuffled } from "../blind-judge.ts"
import type { Verdict } from "../blind-judge.ts"
import { separated, wilson } from "../../src/analysis/coach-score.ts"
import type { Interval } from "../../src/analysis/coach-score.ts"

/* ======================================================================= types */

export interface SheetLine {
	/** Opaque, stable, e.g. "L07". The judge sees this and nothing else identifying. */
	id: string
	/** The TRUE arm. Written to the KEY file only — `renderSheet` never receives it in its output. */
	armKey: string
	clock: string
	atSec: number
	text: string
	/** Real, and deliberately absent from the sheet: it is an arm label in milliseconds. */
	latencyMs: number
	block: string
	offered: string[]
	frameB64: string | null
	windowId: string
	/**
	 * How far the picture is from the instant the block describes, or null for a card with no
	 * picture. SHOWN, unlike latency, because it is a property of the TURN and identical across
	 * every arm that spoke at it — so it groups nothing and leaks nothing.
	 *
	 * The card asserts one clock and shows a frame paired up to `DEFAULT_MAX_SKEW_MS` (3s) away
	 * from it; the two windows on disk have median skews of 1339ms and 1619ms. Three seconds of
	 * game clock covers a death, a smite, or the end of a fight, and `false` is the fatal verdict
	 * — a judge checking "is this sentence true of this instant" against a picture a second and a
	 * half off must be told which of the two he is looking at.
	 */
	skewMs: number | null
}

/** One row of the key file: everything needed to reveal, and nothing the sheet showed. */
export interface SheetKeyRow {
	armKey: string
	windowId: string
	clock: string
	atSec: number
	latencyMs: number
	text: string
}

/* ==================================================================== blinding */

/**
 * A stable seed from the ids alone.
 *
 * FNV-1a over the ids SORTED, so the shuffle depends on which lines are in the sheet and not on
 * the order the driver happened to build them in — otherwise re-rendering the same run after a
 * loop was reordered produces a differently shuffled sheet, and a half-finished grading session
 * cannot be lined up against it.
 */
export const seedFromIds = (ids: readonly string[]): number => {
	let h = 0x811c9dc5
	for (const id of [...ids].sort())
		for (let i = 0; i < id.length; i++) {
			h ^= id.charCodeAt(i)
			h = Math.imul(h, 0x01000193) >>> 0
		}
	return h >>> 0
}

/**
 * A short, filesystem- and `localStorage`-safe key.
 *
 * It is NOT derived from the title any more, and that is a correction to a real defect. The title
 * `bench-stream · <window ids> · <N> lines` carries no run identity, so five sheets on disk
 * collapsed to two distinct slugs and the ids are `L01…LNN` in every one of them. On Chrome all
 * `file://` documents share one storage origin, so opening the second sheet loaded the FIRST run's
 * verdicts, pre-painted onto different sentences from a different model — and `revealVerdicts`
 * could not see it, because it only flags ids ABSENT from the key and a colliding run's ids all
 * match. That is the tool manufacturing a measurement, which is the one thing this repo forbids.
 * The driver now passes an explicit per-run `storeKey` (its output stamp), it is written into the
 * key file and into every exported verdicts payload, and the reveal REFUSES to join two files
 * whose keys disagree.
 */
export const slug = (text: string): string =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64) || "sheet"

/**
 * The order the buttons appear in, and the digits that pick them.
 *
 * Best-to-worst, which is NOT the order `VERDICTS` is declared in. The hints are the definitions
 * from `blind-judge.ts`, on the card, because a judge who has to remember what `generic` means at
 * card ninety has already started guessing.
 */
const BUTTONS: { id: Verdict; digit: number; hint: string }[] = [
	{ id: "useful", digit: 1, hint: "true, specific to THIS instant, names something to do" },
	{ id: "generic", digit: 2, hint: "true and checkable, but would read the same in another game" },
	{ id: "unverifiable", digit: 3, hint: "might be true; nothing here can check it" },
	{ id: "false", digit: 4, hint: "contradicts the block, or asserts what nothing knows" }
]

/* ================================================================ the payload */

/**
 * Only these fields cross into the page. Built field by field rather than spread from `SheetLine`,
 * so adding a revealing field to that interface later cannot silently leak it into the sheet.
 */
interface WireLine {
	id: string
	clock: string
	atSec: number
	windowId: string
	text: string
	block: string
	offered: string[]
	/** index into the deduplicated frame table, or -1 for "no screenshot for this line". */
	frame: number
	/** Wall-clock ms between that screenshot and the instant the block describes. */
	skewMs: number | null
}

/** Inline every JPEG once. The same instant is spoken over by every arm; the pixels are identical. */
const dedupeFrames = (lines: readonly SheetLine[]): { frames: string[]; indexOf: Map<string, number> } => {
	const frames: string[] = []
	const indexOf = new Map<string, number>()
	for (const l of lines) {
		if (l.frameB64 === null || l.frameB64 === "") continue
		if (indexOf.has(l.frameB64)) continue
		indexOf.set(l.frameB64, frames.length)
		frames.push(l.frameB64)
	}
	return { frames, indexOf }
}

/**
 * JSON that is safe as the text content of a `<script type="application/json">`.
 *
 * A `<` inside a string is the only sequence that can end that element early, so escaping it is
 * sufficient and it means nothing in a spoken line, a block or a note can break the page. The
 * page reads the payload with `JSON.parse`, so nothing is ever interpolated into executable
 * source and no HTML escaping of the coach's own words is needed anywhere else.
 */
const embed = (value: unknown): string => JSON.stringify(value).replace(/</g, "\\u003c")

/* ============================================================ the sheet itself */

/**
 * The four strings the disclosure is labelled with.
 *
 * They are captions, not data, and they default to the live-coach wording this file was written
 * for. A post-game sheet's disclosure holds the item's own cited evidence and the pack's state at
 * that clock — calling that "the ranked, rate-limited list" would be a caption that lies about
 * what the reader is looking at, and the reader is grading truthfulness.
 */
export interface SheetLabels {
	summary: string
	offered: string
	block: string
	offeredEmpty: string
}

const DEFAULT_LABELS: SheetLabels = {
	summary: "the ground-truth block it was given, and the ranked facts it was offered",
	offered: "offered (the ranked, rate-limited list)",
	block: "block",
	offeredEmpty:
		"(the ranker offered nothing at this instant — under cite-or-quiet that is not an instruction to be silent, so a line here is not automatically a violation)"
}

export const renderSheet = (
	lines: readonly SheetLine[],
	meta: { title: string; note: string; storeKey: string; labels?: Partial<SheetLabels> }
): string => {
	const order = shuffled(lines, seedFromIds(lines.map(l => l.id)))
	const { frames, indexOf } = dedupeFrames(lines)
	const wire: WireLine[] = order.map(l => ({
		id: l.id,
		clock: l.clock,
		atSec: l.atSec,
		windowId: l.windowId,
		text: l.text,
		block: l.block,
		offered: l.offered,
		frame: l.frameB64 === null || l.frameB64 === "" ? -1 : (indexOf.get(l.frameB64) ?? -1),
		skewMs: l.skewMs
	}))
	const payload = {
		title: meta.title,
		note: meta.note,
		storeKey: slug(meta.storeKey),
		labels: { ...DEFAULT_LABELS, ...meta.labels },
		verdicts: BUTTONS,
		frames,
		lines: wire
	}

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title.replace(/</g, "&lt;")}</title>
<style>
${CSS}
</style>
</head>
<body>
<header id="bar">
	<div class="bar-left">
		<h1 id="title"></h1>
		<p id="note"></p>
	</div>
	<div class="bar-right">
		<label class="filter">show
			<select id="filter">
				<option value="all">all</option>
				<option value="ungraded">ungraded</option>
				<option value="graded">graded</option>
			</select>
		</label>
		<button id="jump" type="button">next ungraded (u)</button>
		<button id="toExport" type="button">export (e)</button>
		<span id="progress">0 / 0 graded</span>
	</div>
</header>

<div id="legend">
	<span class="lg"><b>1</b> useful — true, specific to this instant, names something to DO</span>
	<span class="lg"><b>2</b> generic — true, but would read the same in another game</span>
	<span class="lg"><b>3</b> unverifiable — may be true, nothing here can check it</span>
	<span class="lg"><b>4</b> false — contradicts the block, or asserts what nothing knows</span>
	<span class="lg dim">j/k or arrows move · 0 or backspace clears · n writes a note · b opens the block · click the shot to enlarge</span>
</div>

<main id="cards"></main>

<section id="export">
	<h2>Export</h2>
	<p class="dim">Both paths exist on purpose: a <code>file://</code> download is blocked in some
	browsers, and a grading pass whose only export was the blocked one is a grading pass you get to
	do twice. Copy the text if the button does nothing.</p>
	<div class="row">
		<button id="download" type="button">download verdicts.json</button>
		<button id="selectAll" type="button">select all</button>
		<button id="load" type="button">load pasted JSON back in</button>
		<span id="exportState" class="dim"></span>
	</div>
	<textarea id="out" spellcheck="false"></textarea>
</section>

<div id="lightbox" hidden><img id="lightbox-img" alt="full-size frame"></div>
<div id="flash" hidden></div>

<script id="sheet-data" type="application/json">${embed(payload)}</script>
<script>
${PAGE_JS}
</script>
</body>
</html>
`
}

/* ========================================================================= CSS */

const CSS = `
:root {
	color-scheme: dark;
	--bg: #0d0f13;
	--card: #161a21;
	--edge: #262d38;
	--ink: #e8edf4;
	--dim: #94a1b1;
	--useful: #3fb950;
	--generic: #d29922;
	--unverifiable: #a371f7;
	--false: #f85149;
}
* { box-sizing: border-box }
/* An id selector beats the UA's \`[hidden] { display: none }\`, and every hide on this page is the
   hidden attribute. Without this the lightbox is open the moment the sheet loads. */
[hidden] { display: none !important }
body {
	margin: 0;
	background: var(--bg);
	color: var(--ink);
	font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1 { font-size: 17px; margin: 0 }
h2 { font-size: 15px; margin: 0 0 6px }
.dim { color: var(--dim) }
code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace }

#bar {
	position: sticky; top: 0; z-index: 5;
	display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap;
	padding: 10px 18px;
	background: #10141a; border-bottom: 1px solid var(--edge);
}
#bar p { margin: 2px 0 0; color: var(--dim); font-size: 12.5px; max-width: 70ch }
.bar-right { display: flex; gap: 10px; align-items: center; font-size: 13px }
#progress { font-variant-numeric: tabular-nums; color: var(--dim) }
select, button, textarea { font: inherit; color: var(--ink) }
select, button {
	background: #1c222b; border: 1px solid var(--edge); border-radius: 6px;
	padding: 5px 10px; font-size: 13px; cursor: pointer;
}
button:hover { border-color: #3a4453 }
.filter { color: var(--dim); font-size: 13px }

#legend {
	display: flex; flex-wrap: wrap; gap: 6px 18px;
	padding: 8px 18px; font-size: 12.5px; color: var(--dim);
	border-bottom: 1px solid var(--edge); background: #0f1319;
}
.lg b { color: var(--ink) }

main { max-width: 1180px; margin: 0 auto; padding: 20px 18px 40px }

.card {
	background: var(--card);
	border: 1px solid var(--edge); border-left: 4px solid var(--edge);
	border-radius: 10px; padding: 14px 16px 16px; margin: 0 0 22px;
	scroll-margin-top: 130px;
}
.card.current { border-color: #4c586b; box-shadow: 0 0 0 1px #4c586b }
.card.v-useful { border-left-color: var(--useful) }
.card.v-generic { border-left-color: var(--generic) }
.card.v-unverifiable { border-left-color: var(--unverifiable) }
.card.v-false { border-left-color: var(--false) }

.head {
	display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap;
	font-size: 12.5px; color: var(--dim); margin-bottom: 10px;
}
.head .cid { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--ink); font-size: 13px }
.head .clock { font-variant-numeric: tabular-nums; color: var(--ink) }
.head .skew { color: var(--dim); font-variant-numeric: tabular-nums }
.head .state { margin-left: auto; text-transform: uppercase; letter-spacing: .06em; font-size: 11px }

.shot {
	display: block; width: 100%; max-height: 62vh; object-fit: contain;
	background: #05070a; border: 1px solid var(--edge); border-radius: 6px; cursor: zoom-in;
}
.noshot {
	padding: 18px; text-align: center; color: var(--dim); font-size: 13px;
	border: 1px dashed var(--edge); border-radius: 6px; background: #11151b;
}

/* \`white-space: pre-wrap\` because a card's text is not always one sentence. A live-coach sheet
   puts one spoken line here; a post-game sheet puts a claim, then the fix, then the reasoning, and
   a paragraph break that collapses to a space turns three separate jobs into one wall of type. */
.line {
	font-size: 22px; line-height: 1.35; margin: 14px 2px 16px; white-space: pre-wrap;
}
.line.silent { color: var(--dim); font-style: italic; font-size: 17px }
/* Paragraphs after the first. The first one is the CLAIM and stays at scan-it-from-the-doorway
   size; what follows is read rather than scanned, and at 22px it drives the frame off the screen. */
.line-sub {
	font-size: 15.5px; line-height: 1.55; margin: 0 2px 12px; color: #cfd8e3; white-space: pre-wrap;
}

.grade { display: flex; gap: 8px; flex-wrap: wrap }
.grade button {
	display: flex; gap: 8px; align-items: baseline;
	padding: 7px 12px; font-size: 13.5px;
}
.grade button .k {
	font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--dim); font-size: 12px;
}
.grade button .h { color: var(--dim); font-size: 11.5px }
.grade button[data-v="useful"].on { background: var(--useful); border-color: var(--useful); color: #07130a }
.grade button[data-v="generic"].on { background: var(--generic); border-color: var(--generic); color: #150e00 }
.grade button[data-v="unverifiable"].on { background: var(--unverifiable); border-color: var(--unverifiable); color: #0d0518 }
.grade button[data-v="false"].on { background: var(--false); border-color: var(--false); color: #180404 }
.grade button.on .k, .grade button.on .h { color: inherit; opacity: .75 }

.note {
	display: block; width: 100%; margin-top: 10px; min-height: 34px; resize: vertical;
	background: #11151b; border: 1px solid var(--edge); border-radius: 6px; padding: 7px 9px;
	font-size: 13px;
}
details { margin-top: 12px; border-top: 1px solid var(--edge); padding-top: 10px }
summary { cursor: pointer; color: var(--dim); font-size: 12.5px }
details pre {
	white-space: pre-wrap; word-break: break-word; margin: 10px 0 0;
	font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; color: #c6d0dc;
	background: #0f1319; border: 1px solid var(--edge); border-radius: 6px; padding: 10px;
	max-height: 46vh; overflow: auto;
}
details h3 { font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--dim); margin: 12px 0 0 }

#export { max-width: 1180px; margin: 0 auto; padding: 0 18px 60px }
#export .row { display: flex; gap: 10px; align-items: center; margin: 10px 0 }
#out {
	width: 100%; min-height: 180px; background: #0f1319; border: 1px solid var(--edge);
	border-radius: 8px; padding: 10px; font-family: ui-monospace, Menlo, Consolas, monospace;
	font-size: 12px;
}

#lightbox {
	position: fixed; inset: 0; z-index: 20; background: rgba(3,5,8,.94);
	display: block; overflow: auto; padding: 16px; text-align: center; cursor: zoom-out;
}
/* FULL size, not fit-to-window — the card already shows it fitted, and the reason to open this is
   to read a number off the HUD. An oversized frame scrolls. */
#lightbox img { max-width: none; height: auto }

#flash {
	position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 30;
	background: #1c222b; border: 1px solid var(--edge); border-radius: 8px;
	padding: 8px 14px; font-size: 13px; color: var(--ink);
}
`

/* ==================================================================== page JS */

/*
 * No template literals and no `${` anywhere below: this string is itself inside a template literal
 * in `renderSheet`, and one stray backtick would end the page's script at a place no test looks.
 * Plain concatenation is worth the small ugliness.
 */
const PAGE_JS = `
"use strict"
var D = JSON.parse(document.getElementById("sheet-data").textContent)
var STORE = "eepalytics.sheet." + D.storeKey
var state = loadState()
var cards = []
var cur = 0

function loadState() {
	try {
		var raw = window.localStorage.getItem(STORE)
		return raw ? JSON.parse(raw) : {}
	} catch (e) {
		return {}
	}
}
function saveState() {
	try {
		window.localStorage.setItem(STORE, JSON.stringify(state))
	} catch (e) {
		flash("localStorage refused the write — EXPORT before you close this tab")
	}
}
function el(tag, cls, text) {
	var n = document.createElement(tag)
	if (cls) n.className = cls
	if (text !== undefined) n.textContent = text
	return n
}
var flashTimer = null
function flash(msg) {
	var f = document.getElementById("flash")
	f.textContent = msg
	f.hidden = false
	if (flashTimer) clearTimeout(flashTimer)
	flashTimer = setTimeout(function () { f.hidden = true }, 3200)
}

document.getElementById("title").textContent = D.title
document.getElementById("note").textContent = D.note

/* ---------------------------------------------------------------- the cards */

var main = document.getElementById("cards")
D.lines.forEach(function (l, i) {
	var card = el("article", "card")
	card.dataset.id = l.id
	card.tabIndex = -1

	var head = el("div", "head")
	head.appendChild(el("span", "cid", l.id))
	head.appendChild(el("span", "clock", l.clock))
	head.appendChild(el("span", "win", l.windowId))
	/* The frame is paired by WALL clock and can sit up to 3s from the instant the block describes.
	   Shown so a "false" verdict is never cast on a picture of a different second. */
	if (l.frame >= 0 && typeof l.skewMs === "number")
		head.appendChild(el("span", "skew", "frame " + (l.skewMs >= 0 ? "+" : "") + (l.skewMs / 1000).toFixed(1) + "s off this clock"))
	var st = el("span", "state", "ungraded")
	head.appendChild(st)
	card.appendChild(head)

	if (l.frame >= 0) {
		var img = el("img", "shot")
		img.loading = "lazy"
		img.alt = "frame at " + l.clock
		img.src = "data:image/jpeg;base64," + D.frames[l.frame]
		img.addEventListener("click", function () { openLightbox(img.src) })
		card.appendChild(img)
	} else {
		card.appendChild(el("div", "noshot", "no screenshot paired with this line — grade it on the block alone"))
	}

	/* The first paragraph is the claim and gets the big type; every paragraph after it is the fix
	   and the reasoning. A single spoken sentence contains no blank line and renders as it always did. */
	var said = (l.text || "").trim()
	var parts = said === "" ? [] : said.split("\\n\\n")
	var line = el("p", "line" + (said === "" ? " line silent" : ""), said === "" ? "(the coach said nothing on this turn)" : parts[0])
	card.appendChild(line)
	for (var pi = 1; pi < parts.length; pi++) card.appendChild(el("p", "line-sub", parts[pi]))

	var grade = el("div", "grade")
	D.verdicts.forEach(function (v) {
		var b = el("button")
		b.type = "button"
		b.dataset.v = v.id
		b.appendChild(el("span", "k", String(v.digit)))
		b.appendChild(el("span", "l", v.id))
		b.appendChild(el("span", "h", v.hint))
		b.addEventListener("click", function () {
			cur = i
			setVerdict(i, v.id)
		})
		grade.appendChild(b)
	})
	card.appendChild(grade)

	var note = el("textarea", "note")
	note.placeholder = "note (optional) — what made it that, in your words"
	note.rows = 1
	note.addEventListener("input", function () {
		var rec = state[l.id] || (state[l.id] = { verdict: null, note: "" })
		rec.note = note.value
		saveState()
		paint(i)
		/* writeExport() is otherwise reached only through progress(), which a note does not call —
		   so the common ending (grade, type why, "select all", copy) copied a payload that predated
		   the note. This is the fallback path the whole export design leans on; it may not lag. */
		writeExport()
	})
	card.appendChild(note)

	var det = el("details")
	det.appendChild(el("summary", null, D.labels.summary))
	det.appendChild(el("h3", null, D.labels.offered))
	det.appendChild(el("pre", null, l.offered.length ? l.offered.map(function (f, n) { return (n + 1) + ". " + f }).join("\\n") : D.labels.offeredEmpty))
	det.appendChild(el("h3", null, D.labels.block))
	det.appendChild(el("pre", null, l.block))
	card.appendChild(det)

	card.addEventListener("mousedown", function () { setCurrent(i, false) })
	main.appendChild(card)
	cards.push({ line: l, node: card, state: st, note: note, buttons: grade })
})

/* ------------------------------------------------------------------ painting */

function paint(i) {
	var c = cards[i]
	var rec = state[c.line.id]
	var v = rec && rec.verdict ? rec.verdict : null
	c.node.className = "card" + (v ? " v-" + v : "") + (i === cur ? " current" : "")
	c.state.textContent = v ? v : (rec && rec.note ? "noted, ungraded" : "ungraded")
	var bs = c.buttons.querySelectorAll("button")
	for (var k = 0; k < bs.length; k++) bs[k].classList.toggle("on", bs[k].dataset.v === v)
	if (rec && typeof rec.note === "string" && c.note.value !== rec.note) c.note.value = rec.note
}
function paintAll() {
	for (var i = 0; i < cards.length; i++) paint(i)
	progress()
	applyFilter()
}
function progress() {
	var n = 0
	for (var i = 0; i < cards.length; i++) {
		var rec = state[cards[i].line.id]
		if (rec && rec.verdict) n++
	}
	document.getElementById("progress").textContent = n + " / " + cards.length + " graded"
	writeExport()
}

/* ------------------------------------------------------------------ grading */

/* Setting is idempotent and clearing is its own key. The old "rec.verdict === v ? null : v" looked
   like a toggle and was not one: setVerdict advances, so by the time the same digit is pressed
   again "cur" has moved and the second press graded the NEXT card instead of undoing this one. */
function setVerdict(i, v) {
	var id = cards[i].line.id
	var rec = state[id] || (state[id] = { verdict: null, note: "" })
	rec.verdict = v
	saveState()
	paint(i)
	progress()
	advance()
}
function clearVerdict(i) {
	var id = cards[i].line.id
	var rec = state[id]
	if (!rec || !rec.verdict) return
	rec.verdict = null
	saveState()
	paint(i)
	progress()
	flash("cleared " + id + " — it is ungraded again")
}
function visibleIndices() {
	var out = []
	for (var i = 0; i < cards.length; i++) if (!cards[i].node.hidden) out.push(i)
	return out
}
function setCurrent(i, scroll) {
	var was = cur
	cur = i
	paint(was)
	paint(cur)
	if (scroll) cards[cur].node.scrollIntoView({ block: "start", behavior: "smooth" })
}
function move(delta) {
	var vis = visibleIndices()
	if (!vis.length) return
	var at = vis.indexOf(cur)
	if (at < 0) {
		setCurrent(vis[0], true)
		return
	}
	var next = Math.min(vis.length - 1, Math.max(0, at + delta))
	setCurrent(vis[next], true)
}
function advance() {
	/* Auto-advance is what makes a hundred and sixty-eight cards finishable. Under the "ungraded"
	   filter the card just graded disappears, so the next visible index is already the next line. */
	if (document.getElementById("filter").value === "ungraded") {
		applyFilter()
		var vis = visibleIndices()
		if (!vis.length) return
		var forward = vis.filter(function (i) { return i >= cur })
		setCurrent(forward.length ? forward[0] : vis[vis.length - 1], true)
		return
	}
	move(1)
}
function nextUngraded() {
	for (var d = 1; d <= cards.length; d++) {
		var i = (cur + d) % cards.length
		var rec = state[cards[i].line.id]
		if (!rec || !rec.verdict) {
			setCurrent(i, true)
			return
		}
	}
	flash("every line is graded — export it")
}

/* ------------------------------------------------------------------- filter */

function applyFilter() {
	var mode = document.getElementById("filter").value
	for (var i = 0; i < cards.length; i++) {
		var rec = state[cards[i].line.id]
		var graded = !!(rec && rec.verdict)
		cards[i].node.hidden = (mode === "ungraded" && graded) || (mode === "graded" && !graded)
	}
}
document.getElementById("filter").addEventListener("change", function () {
	applyFilter()
	var vis = visibleIndices()
	if (vis.length && cards[cur].node.hidden) setCurrent(vis[0], true)
})
document.getElementById("jump").addEventListener("click", nextUngraded)

/* ------------------------------------------------------------------- export */

/* The payload names the run it came from. Ids are L01...LNN in every sheet this tool has ever
   written, so a verdicts file without a storeKey can be joined to the WRONG key with every id
   matching and no warning anywhere — the reveal then prints a full Wilson table about other
   people's sentences. revealVerdicts refuses that join when both sides name a run. */
function exportObject() {
	var out = {}
	for (var i = 0; i < cards.length; i++) {
		var id = cards[i].line.id
		var rec = state[id]
		if (!rec) continue
		if (!rec.verdict && !(rec.note || "").trim()) continue
		out[id] = { verdict: rec.verdict || null, note: rec.note || "" }
	}
	return { storeKey: D.storeKey, verdicts: out }
}
function writeExport() {
	document.getElementById("out").value = JSON.stringify(exportObject(), null, 1)
}
document.getElementById("download").addEventListener("click", function () {
	try {
		var blob = new Blob([JSON.stringify(exportObject(), null, 1) + "\\n"], { type: "application/json" })
		var url = URL.createObjectURL(blob)
		var a = document.createElement("a")
		a.href = url
		a.download = D.storeKey + "-verdicts.json"
		document.body.appendChild(a)
		a.click()
		a.remove()
		setTimeout(function () { URL.revokeObjectURL(url) }, 4000)
		document.getElementById("exportState").textContent = "download offered — if nothing landed, copy the text below"
	} catch (e) {
		document.getElementById("exportState").textContent = "download blocked on file:// — copy the text below"
	}
})
document.getElementById("selectAll").addEventListener("click", function () {
	var t = document.getElementById("out")
	/* Regenerated first: selecting whatever is already in the box is how a stale payload gets
	   copied, and this is the path that exists because a file:// download may be blocked. */
	writeExport()
	t.focus()
	t.select()
})
document.getElementById("load").addEventListener("click", function () {
	var t = document.getElementById("out")
	try {
		var raw = JSON.parse(t.value)
		/* Both shapes: the wrapped one this sheet writes, and the bare id->verdict map earlier
		   sheets wrote and a hand-edited file usually is. */
		var parsed = raw && raw.verdicts && typeof raw.verdicts === "object" ? raw.verdicts : raw
		if (raw && typeof raw.storeKey === "string" && raw.storeKey !== D.storeKey) {
			flash("that file was exported from a DIFFERENT run (" + raw.storeKey + ") — not loaded")
			return
		}
		var n = 0
		for (var id in parsed) {
			if (!Object.prototype.hasOwnProperty.call(parsed, id)) continue
			var v = parsed[id]
			state[id] = typeof v === "string" ? { verdict: v, note: "" } : { verdict: v.verdict || null, note: v.note || "" }
			n++
		}
		saveState()
		paintAll()
		flash("loaded " + n + " verdicts")
	} catch (e) {
		flash("that is not JSON this sheet can read")
	}
})
document.getElementById("toExport").addEventListener("click", function () {
	document.getElementById("export").scrollIntoView({ behavior: "smooth" })
})

/* ---------------------------------------------------------------- lightbox */

function openLightbox(src) {
	var lb = document.getElementById("lightbox")
	document.getElementById("lightbox-img").src = src
	lb.hidden = false
}
function closeLightbox() {
	document.getElementById("lightbox").hidden = true
}
document.getElementById("lightbox").addEventListener("click", closeLightbox)

/* ---------------------------------------------------------------- keyboard */

document.addEventListener("keydown", function (ev) {
	if (!document.getElementById("lightbox").hidden) {
		if (ev.key === "Escape" || ev.key === "Enter") {
			closeLightbox()
			ev.preventDefault()
		}
		return
	}
	var t = ev.target
	var typing = t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT")
	if (typing) {
		if (ev.key === "Escape") t.blur()
		return
	}
	if (ev.metaKey || ev.ctrlKey || ev.altKey) return
	/* OS auto-repeat fires keydown at ~30/s. Without this, holding "1" walks forward grading card
	   after card as "useful" while advance()'s smooth scroll is still animating, and there is no undo
	   and no per-card timestamp to find it afterwards. A held key is not a judgement. */
	if (ev.repeat) return
	if (ev.key === "0" || ev.key === "Backspace" || ev.key === "Delete") {
		clearVerdict(cur)
		ev.preventDefault()
		return
	}
	var digit = D.verdicts.filter(function (v) { return String(v.digit) === ev.key })[0]
	if (digit) {
		setVerdict(cur, digit.id)
		ev.preventDefault()
		return
	}
	if (ev.key === "j" || ev.key === "ArrowDown") { move(1); ev.preventDefault() }
	else if (ev.key === "k" || ev.key === "ArrowUp") { move(-1); ev.preventDefault() }
	else if (ev.key === "u") { nextUngraded(); ev.preventDefault() }
	else if (ev.key === "n") { cards[cur].note.focus(); ev.preventDefault() }
	else if (ev.key === "b") {
		var d = cards[cur].node.querySelector("details")
		if (d) d.open = !d.open
		ev.preventDefault()
	} else if (ev.key === "e") {
		document.getElementById("export").scrollIntoView({ behavior: "smooth" })
		ev.preventDefault()
	}
})

paintAll()
`

/* ========================================================================= key */

/**
 * id -> the true arm, plus everything the reveal needs and the sheet was not allowed to show.
 *
 * A separate file, opened by nothing until the grading is finished — the same discipline as
 * `blind-judge`'s key. `latencyMs` lives here rather than on the card for exactly that reason.
 */
export const renderKey = (lines: readonly SheetLine[], storeKey: string): string => {
	const rows: Record<string, SheetKeyRow> = {}
	for (const l of lines)
		rows[l.id] = {
			armKey: l.armKey,
			windowId: l.windowId,
			clock: l.clock,
			atSec: l.atSec,
			latencyMs: l.latencyMs,
			text: l.text
		}
	// The run identity is written here as well as into the sheet, so `revealVerdicts` has two
	// halves to compare rather than two id lists that always match.
	return `${JSON.stringify({ storeKey: slug(storeKey), rows }, null, 1)}\n`
}

/* ====================================================================== reveal */

const isVerdict = (v: unknown): v is Verdict => typeof v === "string" && (VERDICTS as readonly string[]).includes(v)

/**
 * Parse either shape of key file: a bare `id -> row` map, or `{ rows: ... }` as an array or a map.
 *
 * Forgiving on input and strict on output, because the alternative is a reveal that throws at the
 * end of an evening of grading and a judge who has to guess which file was which.
 */
const keyRows = (keyJson: string): { rows: Map<string, SheetKeyRow>; storeKey: string | null } => {
	const parsed = JSON.parse(keyJson) as Record<string, unknown>
	const raw: Record<string, unknown> =
		parsed && typeof parsed === "object" && "rows" in parsed ?
			(Array.isArray(parsed.rows) ?
				Object.fromEntries((parsed.rows as { id: string }[]).map(r => [r.id, r]))
			:	(parsed.rows as Record<string, unknown>))
		:	parsed
	const storeKey =
		parsed && typeof parsed === "object" && typeof parsed.storeKey === "string" ?
			parsed.storeKey
		:	null
	const out = new Map<string, SheetKeyRow>()
	for (const [id, row] of Object.entries(raw)) {
		if (!row || typeof row !== "object") continue
		const r = row as Partial<SheetKeyRow> & { arm?: string }
		const armKey = r.armKey ?? r.arm
		if (typeof armKey !== "string") continue
		out.set(id, {
			armKey,
			windowId: r.windowId ?? "",
			clock: r.clock ?? "",
			atSec: r.atSec ?? 0,
			latencyMs: r.latencyMs ?? 0,
			text: r.text ?? ""
		})
	}
	return { rows: out, storeKey }
}

const pct = (i: Interval): string => `${(100 * i.p).toFixed(0)}%`
const ci = (i: Interval): string => `[${(100 * i.lo).toFixed(0)}, ${(100 * i.hi).toFixed(0)}]`
const pad = (s: string, w: number): string => (s.length >= w ? s : s + " ".repeat(w - s.length))
const padL = (s: string, w: number): string => (s.length >= w ? s : " ".repeat(w - s.length) + s)

/**
 * Join the key to the verdicts and print what the two together support — and only that.
 *
 * Every rate carries n and a Wilson interval, every pair of arms is run through `separated`, and
 * the pairs that do NOT separate are printed saying so in words. Two overlapping percentages side
 * by side are read as a difference by everyone including the person who computed them; the only
 * fix that has ever worked in this repo is to write the negative result into the line itself.
 *
 * Ungraded ids are never counted. They leave the denominator and reappear as their own number at
 * the top, because an ungraded line silently scored as `useful` is a free win and n is small
 * enough here that a handful of them would decide the table.
 */
export const revealVerdicts = (keyJson: string, verdictsJson: string): string => {
	const { rows: key, storeKey: keyStore } = keyRows(keyJson)
	const parsedVerdicts = JSON.parse(verdictsJson) as Record<string, unknown>
	/*
	 * A verdicts file is either the wrapped `{ storeKey, verdicts }` this sheet writes now, or the
	 * bare `id -> verdict` map it used to write. Both are read; only the first can be CHECKED.
	 */
	const verdictStore =
		parsedVerdicts && typeof parsedVerdicts === "object" && typeof parsedVerdicts.storeKey === "string" ?
			parsedVerdicts.storeKey
		:	null
	const rawVerdicts =
		parsedVerdicts &&
		typeof parsedVerdicts === "object" &&
		parsedVerdicts.verdicts !== undefined &&
		typeof parsedVerdicts.verdicts === "object" ?
			(parsedVerdicts.verdicts as Record<string, unknown>)
		:	parsedVerdicts

	/*
	 * REFUSE, do not report. Ids are `L01…LNN` in every sheet this tool has written, so verdicts
	 * from another run join cleanly, every id matches, `unknownIds` stays empty, and the reveal
	 * prints per-arm rates and a pairwise separation test about sentences nobody graded. That is a
	 * fabricated measurement produced by the instrument itself.
	 */
	if (keyStore !== null && verdictStore !== null && keyStore !== verdictStore)
		return (
			`${"─".repeat(96)}\n` +
			`REFUSED: these two files are from DIFFERENT runs.\n` +
			`${"─".repeat(96)}\n\n` +
			`  key      ${keyStore}\n` +
			`  verdicts ${verdictStore}\n\n` +
			`  Every sheet numbers its lines L01…LNN, so the ids would have joined without a single\n` +
			`  complaint and the table below would have been about other sentences. Nothing is reported.\n` +
			`  Find the key written beside the run these verdicts came from.\n`
		)

	const given = new Map<string, Verdict>()
	const noteOf = new Map<string, string>()
	const unknownIds: string[] = []
	const badValues: string[] = []
	for (const [id, value] of Object.entries(rawVerdicts ?? {})) {
		const v = typeof value === "string" ? value : (value as { verdict?: unknown })?.verdict
		const note = typeof value === "object" && value !== null ? ((value as { note?: string }).note ?? "") : ""
		if (note !== "") noteOf.set(id, note)
		if (!key.has(id)) {
			unknownIds.push(id)
			continue
		}
		if (v === null || v === undefined || v === "") continue
		if (!isVerdict(v)) {
			badValues.push(`${id}=${String(v)}`)
			continue
		}
		given.set(id, v)
	}

	const arms = [...new Set([...key.values()].map(r => r.armKey))].sort()
	const out: string[] = []
	const rule = "─".repeat(96)

	const ungraded = [...key.keys()].filter(id => !given.has(id))
	out.push(rule)
	out.push(`reveal · ${key.size} lines in the key · ${given.size} graded · ${ungraded.length} ungraded · ${arms.length} arms`)
	out.push(rule)
	out.push("")
	out.push(
		keyStore !== null && verdictStore !== null ?
			`  run ${keyStore} — key and verdicts agree on which run this is.`
		:	`  !! THE PAIRING COULD NOT BE CHECKED: ${
				keyStore === null ? "the key file" : "the verdicts file"
			} carries no run id, so nothing here\n` +
			`     rules out verdicts graded on a DIFFERENT run's sheet. Ids are L01…LNN in every sheet,\n` +
			`     so a mismatched pair joins silently. Re-export from the sheet if you can.`
	)
	out.push("")
	if (ungraded.length > 0)
		out.push(
			`  ${ungraded.length} line(s) carry no verdict and are EXCLUDED from every denominator below.\n` +
				`  Ungraded by arm: ${arms
					.map(a => `${a} ${ungraded.filter(id => key.get(id)!.armKey === a).length}`)
					.join(" · ")}`
		)
	if (unknownIds.length > 0)
		out.push(`  ${unknownIds.length} id(s) in the verdicts file are not in this key and were dropped: ${unknownIds.slice(0, 8).join(", ")}${unknownIds.length > 8 ? " …" : ""}`)
	if (badValues.length > 0)
		out.push(`  ${badValues.length} verdict value(s) are not one of the four and were dropped: ${badValues.slice(0, 8).join(", ")}`)
	if (given.size === 0) {
		out.push("")
		out.push("  NOTHING IS GRADED. There is no rate to report — this is a result about the grading pass, not the coach.")
		return `${out.join("\n")}\n`
	}
	out.push("")

	/* -- per-arm rates ------------------------------------------------------- */

	const idsOf = (arm: string): string[] => [...key.keys()].filter(id => key.get(id)!.armKey === arm && given.has(id))
	const rates = new Map<string, Record<Verdict, Interval>>()
	for (const arm of arms) {
		const ids = idsOf(arm)
		const n = ids.length
		const row = {} as Record<Verdict, Interval>
		for (const v of VERDICTS) row[v] = wilson(ids.filter(id => given.get(id) === v).length, n)
		rates.set(arm, row)
	}

	const armW = Math.max(6, ...arms.map(a => a.length))
	out.push(`  ${pad("arm", armW)}  ${padL("n", 4)}   ${VERDICTS.map(v => pad(v, 22)).join("")}`)
	for (const arm of arms) {
		const row = rates.get(arm)!
		const n = idsOf(arm).length
		out.push(
			`  ${pad(arm, armW)}  ${padL(String(n), 4)}   ` +
				VERDICTS.map(v => pad(`${row[v].k}/${row[v].n} ${pct(row[v])} ${ci(row[v])}`, 22)).join("")
		)
	}
	out.push("")
	out.push("  Rates are Wilson 95%. `false` is the fatal one; `generic` is the one every mechanical check passes.")

	const thin = arms.filter(a => idsOf(a).length < 10)
	if (thin.length > 0) {
		out.push("")
		out.push(
			`  NOTE: ${thin.map(a => `${a} n=${idsOf(a).length}`).join(", ")} — under ten graded lines. Those intervals\n` +
				"  cover almost any claim. Read the sentences, do not compare arms on numbers this thin."
		)
	}

	/* -- pairwise ------------------------------------------------------------ */

	out.push("")
	out.push("PAIRWISE — non-overlapping Wilson intervals, which is a conservative test")
	out.push("")
	if (arms.length < 2) out.push("  only one arm in the key; nothing to compare")
	for (const v of arms.length < 2 ? [] : VERDICTS) {
		out.push(`  ${v}`)
		let any = false
		for (let i = 0; i < arms.length; i++)
			for (let j = i + 1; j < arms.length; j++) {
				const a = rates.get(arms[i]!)![v]
				const b = rates.get(arms[j]!)![v]
				const sep = separated(a, b)
				if (sep) any = true
				out.push(
					`    ${pad(`${arms[i]} vs ${arms[j]}`, 2 * armW + 6)}  ${pad(`${pct(a)} ${ci(a)}`, 18)} ${pad(`${pct(b)} ${ci(b)}`, 18)}  ` +
						(sep ?
							`SEPARATED — ${a.p > b.p ? arms[i] : arms[j]} higher`
						:	"NOT distinguishable — the intervals overlap, this pair says nothing")
				)
			}
		if (arms.length >= 2 && !any) out.push("    no pair separates on this verdict")
	}

	/* -- the fatal ones, quoted --------------------------------------------- */

	const fatal = [...given.entries()].filter(([, v]) => v === "false")
	out.push("")
	out.push(`EVERY LINE GRADED FALSE (${fatal.length}) — the only fatal verdict, so it is quoted rather than tallied`)
	out.push("")
	if (fatal.length === 0) out.push("  none")
	for (const [id] of fatal) {
		const r = key.get(id)!
		out.push(`  ${pad(id, 6)} ${pad(r.armKey, armW)} ${padL(r.clock, 6)}  "${r.text}"`)
		const note = noteOf.get(id)
		if (note !== undefined && note.trim() !== "") out.push(`  ${" ".repeat(6)} ${" ".repeat(armW)}         note: ${note.trim()}`)
	}

	return `${out.join("\n")}\n`
}
