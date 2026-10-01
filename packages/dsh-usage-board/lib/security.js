/** The read-only usage route is private to local browser clients. */
export function isLoopbackBoardRequest(req) {
	const isLoopback = (address) => {
		if (typeof address !== "string") return false;
		if (address === "::1") return true;
		const value = address.startsWith("::ffff:") ? address.slice(7) : address;
		const parts = value.split(".");
		return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255) && Number(parts[0]) === 127;
	};
	if (!isLoopback(req.socket?.remoteAddress)) return false;
	const host = req.headers.host;
	if (typeof host !== "string") return false;
	let authority;
	try { authority = new URL("http://" + host); } catch { return false; }
	const hostname = authority.hostname.replace(/^\[|\]$/g, "");
	if (authority.username || authority.password || authority.pathname !== "/" || authority.search || authority.hash || !(hostname === "localhost" || isLoopback(hostname))) return false;
	if (req.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = req.headers.origin;
	if (origin === undefined) return true;
	try {
		const value = new URL(origin);
		return value.protocol === "http:" && !value.username && !value.password && value.pathname === "/" && !value.search && !value.hash && value.origin === authority.origin;
	} catch { return false; }
}
