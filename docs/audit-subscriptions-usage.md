# Subscriptions and usage plugins: source audit

This audit covers `dsh-subs-hub` and `dsh-usage-board` in the consolidated suite. It records the source contracts checked, compatibility/security work, and validation limits. Source provenance is retained here separately from the suite's future installation target.

## Source versions and host contracts

The host contract was checked against DeepSeek Harness `0.2.0-rc.2`, source commit `639ed015397290b3745d163aafe02ffee4aa3f84`. The two source plugins came from `dsh-subs-hub` commit `f49e55e22b5c50c11a14dc6d9d07c44de7caecbe` and `dsh-usage-board` commit `f8b4de8cee660f46a3fa009a1d06cb8931626da2`. Both retain their MIT license and attribution files in the package directories.

The audit read the host source implementations for `SettingsForms`, `LlmRuntime`, `CredentialProvider`, `AuthorizationService`, and `WebServer`:

- `SettingsForms` exposes `describe()`, `update()`, `replace()`, and `mutate()` over a plugin entry's live `Config`; it has no `get()` or `register()` method. Neither plugin now assumes those methods. The usage board reads live provider IDs from `ctx.get('llm').listProviders()` instead of trying to read model configuration through SettingsForms.
- `ctx.llm.listProviders()` returns provider metadata with IDs. `registerAdapter()` is exclusive for every requested ID and throws `DUPLICATE_ADAPTER` if any ID has an owner; registrations return a disposer. The hub checks the live registry, skips a claimed route, handles a registration race, and binds each successful adapter disposer to its plugin effect. This matters when an active `llm-pi-ai` profile already claims the same provider ID: the current owner is preserved, and the hub warns that its model adapter was skipped.
- `ctx.webServer.register()` returns a route disposer. Both plugins register inside `ctx.effect()` so the route is removed with the plugin. Their local HTTP handlers enforce loopback peer and Host/Origin checks; the hub additionally bounds and aborts auth-channel bodies and active operations.
- The host's `ctx.credentials` contract includes `credentialRef()` / `resolve()` for environment-style references, plus scoped `credentialKey()` records and serialized `modifyRecord()` for plugin-owned secrets. The usage board resolves `DEEPSEEK_API_KEY` with a branded credential reference on each snapshot. Subscription OAuth sessions remain in the hub's plugin-owned auth file because the hub has several provider-specific OAuth/device flows and a shared UI/session format. The host also offers `ctx.authorization.registerFlow()` for flows that write one scoped credential record; adopting that registry across these legacy provider protocols was not required to fix compatibility and remains a separate migration decision.

## Work completed

The hub now binds OAuth callbacks only on loopback, rejects invalid Host/Origin/state and malformed or oversized callbacks, reserves a provider before binding, bounds concurrent flows, propagates cancellation into OAuth token exchanges, sanitizes provider-controlled error descriptions, and closes/aborts pending work on cancellation or plugin disposal. Its durable session writer validates provider-specific session shape and uses private permissions and atomic replacement. Non-expiring provider sessions are accepted where the provider returns no expiry or refresh token. An existing LLM route is never overwritten, and the hub withdraws routes it owns when disabled.

The usage board now uses the real LLM registry and DSH credential resolver. Its API route is loopback-only and same-origin checked; adapter output, body/config size, provider file count, response size, HTTP cache count/age, per-provider time, and snapshot age are bounded. HTTP bearer-bearing requests may use plaintext only for loopback gateways, reject URL credentials, reject cross-origin redirects before forwarding authorization, and stop on plugin disposal. The per-plugin snapshot cache deduplicates concurrent loads. External provider modules are user-installed executable code, not a sandbox.

The READMEs now describe the DSH home auth path, provider-route ownership, host API behavior, local route fence, external module trust boundary, and the fact that credentials go to their provider API from the backend rather than being returned to the browser.

## Validation

Run from each package directory:

```sh
npm test && npm run check
```

- `dsh-subs-hub`: 65 tests passed; syntax check passed.
- `dsh-usage-board`: 40 tests passed; syntax check passed.

The suites use local HTTP fixtures, injected OAuth/device-flow responses, fake providers, and package-local source assertions. The host API descriptions above come from read-only inspection of the pinned host source, not from claiming a full runtime integration test. No real account credentials, live sign-in, paid model endpoint, or external provider usage request was used. No browser UI session or full host-profile boot was exercised here; the parent integration task owns the combined suite build/pack and host-level gates.
