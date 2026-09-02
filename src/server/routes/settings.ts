/**
 * `GET /api/settings` and `PUT /api/settings`.
 *
 * Settings are stored one key per row and read back merged over `DEFAULT_SETTINGS`, so adding
 * a field is backward compatible with an existing database and never needs a migration.
 *
 * The PUT path is deliberately paranoid about one thing: `captureEnabled`. Turning it on gives
 * the app permission to take over the user's League client, so the write goes through
 * `clampSettings` (a fat-fingered `pollInGameMs: 0` cannot wedge the daemon) and the daemon is
 * notified synchronously, so the new poll intervals and the new gate verdict apply without a
 * restart.
 */

import { Hono } from "hono"
import type { Context } from "hono"
import { type } from "arktype"
import { getSettings, putSettings } from "../../db/queries.ts"
import { SettingsResponse } from "../../shared/schema/api.ts"
import { SettingsPatch, clampSettings } from "../../shared/schema/settings.ts"
import type { Settings } from "../../shared/schema/settings.ts"
import type { ServerDeps } from "../deps.ts"
import { fail, readJson, send } from "../respond.ts"

export const createSettingsRoutes = (deps: ServerDeps): Hono => {
	const app = new Hono()

	app.get("/settings", c =>
		send(c, SettingsResponse, getSettings(), "GET /api/settings")
	)

	const applyPatch = async (c: Context): Promise<Response> => {
		const raw = await readJson(c)
		if (raw === undefined)
			return fail(c, 400, "request body was not valid JSON", "bad-json")

		// `SettingsPatch` has `"+": "delete"`, so unknown keys are dropped rather than stored.
		const patch = SettingsPatch(raw)
		if (patch instanceof type.errors)
			return fail(c, 400, "invalid settings patch", "bad-settings", patch.summary)

		const merged = clampSettings({ ...getSettings(), ...patch } as Settings)
		const next = putSettings(merged)

		try {
			deps.onSettingsChange?.(next)
		} catch (err) {
			console.warn(`[settings] daemon rejected the change: ${(err as Error).message}`)
		}

		return send(c, SettingsResponse, next, "PUT /api/settings")
	}

	app.put("/settings", applyPatch)
	// Some fetch wrappers only speak POST; the semantics are identical (merge, not replace).
	app.post("/settings", applyPatch)

	return app
}
