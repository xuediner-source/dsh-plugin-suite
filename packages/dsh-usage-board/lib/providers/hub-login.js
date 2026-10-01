import { readHubSession, skipped, loggedIn } from "./hub-session.js";

export function hubLoginProvider({ id, label, hubKey }) {
	return {
		id,
		label,
		async fetch() {
			const session = readHubSession(hubKey);
			if (!session) return skipped(id, label);
			return loggedIn(id, label, session);
		}
	};
}
