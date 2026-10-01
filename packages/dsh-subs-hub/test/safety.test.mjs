import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSessionShape, safeDiagnostic, writePrivateJson } from "../lib/auth/safety.js";

const tempDirs = [];
after(async () => Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe("auth store and diagnostics", () => {
	it("accepts non-expiring, non-refreshing provider sessions and keeps expiring OAuth requirements", () => {
		assert.doesNotThrow(() => assertSessionShape("openrouter", { accessToken: "api-key" }));
		assert.doesNotThrow(() => assertSessionShape("agnes", { accessToken: "access-token", userInfo: {} }));
		assert.doesNotThrow(() => assertSessionShape("codex", { accessToken: "access-token", refreshToken: "refresh-token", expiresAt: Date.now() + 1000 }));
		assert.throws(() => assertSessionShape("codex", { accessToken: "access-token", expiresAt: Date.now() + 1000 }), /refreshToken/);
		assert.throws(() => assertSessionShape("qwen", { accessToken: "access-token", refreshToken: "refresh-token" }), /expiresAt/);
	});

	it("redacts provider error echoes of OAuth secrets", () => {
		const message = safeDiagnostic(new Error('HTTP 400 authorization: Bearer secret-token?code=secret-code "refresh_token":"secret-refresh"'));
		assert.doesNotMatch(message, /secret-token|secret-code|secret-refresh/);
		assert.match(message, /\[redacted\]/);
	});

	it("writes atomically with owner-only permissions and stops before commit when aborted", async () => {
		const dir = await mkdtemp(join(tmpdir(), "dsh-safety-"));
		tempDirs.push(dir);
		const file = join(dir, "auth.json");
		await writePrivateJson(file, { codex: { accessToken: "secret" } });
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { codex: { accessToken: "secret" } });
		if (process.platform !== "win32") {
			assert.equal((await stat(file)).mode & 0o777, 0o600);
			assert.equal((await stat(dir)).mode & 0o777, 0o700);
		}
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await assert.rejects(writePrivateJson(file, { changed: true }, controller.signal), /cancelled/);
		assert.deepEqual(await readdir(dir), ["auth.json"]);
	});
});
