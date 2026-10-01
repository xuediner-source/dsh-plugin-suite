/**
 * Copy to ~/.dsh/usage-board/providers/example.js and restart DSH.
 * fetch() receives { credentials, httpsJson, env, logger }.
 * Return { id, label, ok, headline, percent?, resetAt?, details?, error?, skipped? }.
 */
export default {
  id: "example",
  label: "Example",
  async fetch({ httpsJson }) {
    void httpsJson;
    return {
      id: "example",
      label: "Example",
      ok: true,
      skipped: true,
      error: "replace this adapter with a real API call"
    };
  }
};
