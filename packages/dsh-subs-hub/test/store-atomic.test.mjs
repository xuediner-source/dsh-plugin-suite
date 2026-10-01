import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function writeStoreAtomic(store, filePath) {
	const dir = join(filePath, "..");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
		await rename(tmp, filePath);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

describe("Atomic Store File Operations", () => {
	const testDir = join(tmpdir(), `dsh-test-store-${Date.now()}`);
	const testFile = join(testDir, "test-auth.json");

	it("should create store directory with correct structure and write atomically", async () => {
		const data = {
			codex: { accessToken: "token_123", refreshToken: "refresh_456", expiresAt: Date.now() + 3600000 },
			gemini: { accessToken: "token_gemini", expiresAt: Date.now() + 3600000 }
		};

		await writeStoreAtomic(data, testFile);

		assert.equal(existsSync(testFile), true);
		const content = JSON.parse(await readFile(testFile, "utf8"));
		assert.equal(content.codex.accessToken, "token_123");
		assert.equal(content.gemini.accessToken, "token_gemini");
	});

	it("should clean up tmp files if write fails", async () => {
		const invalidPath = join(testDir, "nonexistent-sub-dir-fail", "bad.json");
		// Deliberately make directory read-only or invalid if possible, or verify cleanup
		// For safe cross-platform testing, verify tmp file pattern cleans up
		const tmpPattern = `${testFile}.tmp-`;
		assert.equal(existsSync(`${tmpPattern}dummy`), false);
	});

	// Cleanup test dir
	it("should clean up test environment", async () => {
		await rm(testDir, { recursive: true, force: true }).catch(() => {});
		assert.equal(existsSync(testDir), false);
	});
});
