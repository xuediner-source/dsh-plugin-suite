import { randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const OWNER_DIR = 0o700;
const OWNER_FILE = 0o600;

/** Keep provider-controlled diagnostics from echoing common credential fields. */
export function safeDiagnostic(error, limit = 1000) {
	let message = error instanceof Error ? error.message : String(error);
	message = message
		.replace(/\bBearer\s+[^\s,;"']+/giu, "Bearer [redacted]")
		.replace(/([?&](?:access_token|refresh_token|token|client_secret|client_id|code_verifier|code|state|key)=)[^&#\s]*/giu, "$1[redacted]")
		.replace(/(["']?(?:access_token|refresh_token|client_secret|client_id|code_verifier|authorization)["']?\s*[:=]\s*["']?)[^"'\s&,}]*/giu, "$1[redacted]");
	return message.slice(0, limit);
}

/** Validate provider-specific durable token records without normalizing away protocol differences. */
export function assertSessionShape(provider, value) {
	if (typeof value !== "object" || value === null) throw new Error(`subscriptions auth store: entry "${provider}" is not an object; fix or delete the store file`);
	const entry = value;
	const expiryOptional = provider === "openrouter" || provider === "agnes";
	if (typeof entry.accessToken !== "string" || entry.accessToken.length === 0 || entry.accessToken.length > 65536 || (!expiryOptional && (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt))) || (entry.expiresAt !== void 0 && (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)))) throw new Error(`subscriptions auth store: entry "${provider}" is missing accessToken/expiresAt; fix or delete the store file`);
	if (provider === "openrouter" || provider === "agnes") {
		if (entry.refreshToken !== void 0 && (typeof entry.refreshToken !== "string" || entry.refreshToken.length === 0)) throw new Error(`subscriptions auth store: entry "${provider}" has an invalid refreshToken; fix or delete the store file`);
	} else if (typeof entry.refreshToken !== "string" || entry.refreshToken.length === 0) {
		throw new Error(`subscriptions auth store: entry "${provider}" is missing refreshToken; fix or delete the store file`);
	}
}

/** Write JSON using a unique exclusive temporary file in an owner-only directory. */
export async function writePrivateJson(filePath, value, signal) {
	signal?.throwIfAborted();
	const dir = dirname(filePath);
	await mkdir(dir, { recursive: true, mode: OWNER_DIR });
	if (process.platform !== "win32") await chmod(dir, OWNER_DIR);
	signal?.throwIfAborted();
	const temp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temp, JSON.stringify(value, null, 2), { mode: OWNER_FILE, flag: "wx", signal });
		if (process.platform !== "win32") await chmod(temp, OWNER_FILE);
		signal?.throwIfAborted();
		await rename(temp, filePath);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}
