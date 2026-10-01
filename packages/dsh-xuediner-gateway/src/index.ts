/**
 * dsh-xuediner-gateway -> xuedinerAPI
 *
 * Registers the unified provider and keeps DSH's native provider settings
 * projection attached to this Loader entry. Pool commands and HTTP routes
 * are optional host services and are registered in their own child scopes.
 */
import { Context } from '@deepseek-ai/cordis';
import type { Volatile } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import {
  DEFAULT_API_KEY,
  DEFAULT_BASE_URL,
  PROVIDER,
  XuedinerApiAdapter,
} from './adapter.js';
import { registerPoolCommand, registerPoolRoute } from './pool-hub.js';

export interface Config {
  /** WorkBuddy-compatible gateway endpoint. */
  baseURL: Volatile<string>;
  /** Credential reference resolved for each gateway request. */
  apiKeyEnv: Volatile<string>;
}

/** Native Loader/Settings form; credential values remain in ctx.credentials. */
export const Config = Schema.object({
  baseURL: Schema.string().default(DEFAULT_BASE_URL).volatile(),
  apiKeyEnv: Schema.string().role('credential-ref').default('XUEDINER_API_KEY').volatile(),
});

export const name = 'xuediner-api';
export const inject = ['llm'];

type ResolvedCredential = { value: string };
type CredentialService = { resolve: (ref: string) => Promise<ResolvedCredential | undefined> };

const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LEGACY_KEY_REFS = ['XUEDINER_API_KEY', 'XUEDINER_GATEWAY_API_KEY', 'WORKBUDDY_GATEWAY_API_KEY'] as const;

function configuredBaseUrl(config: Config): string {
  return process.env.XUEDINER_API_BASE_URL
    ?? process.env.XUEDINER_GATEWAY_URL
    ?? process.env.WORKBUDDY_GATEWAY_BASE_URL
    ?? process.env.WORKBUDDY_GATEWAY_URL
    ?? config.baseURL.get()
    ?? DEFAULT_BASE_URL;
}

/** @internal Resolve a configured credential reference without exposing its value to settings. */
export async function resolveApiKey(ctx: Context, config: Config): Promise<string> {
  const configuredRef = config.apiKeyEnv.get();
  if (!CREDENTIAL_REF.test(configuredRef)) {
    throw new Error('Invalid gateway credential reference');
  }

  const isDefaultRef = configuredRef === LEGACY_KEY_REFS[0];
  // Legacy aliases are only compatibility fallbacks for the unchanged default.
  // A user-selected credential reference must never silently select another key.
  const refs = isDefaultRef ? [...new Set([configuredRef, ...LEGACY_KEY_REFS])] : [configuredRef];
  let credentials: CredentialService | undefined;
  try {
    credentials = ctx.get('credentials') as CredentialService | undefined;
  } catch {
    credentials = undefined;
  }

  for (const ref of refs) {
    if (!CREDENTIAL_REF.test(ref)) continue;
    if (credentials !== undefined && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve(ref);
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value;
    }
    // Preserve the historical environment-variable aliases for lightweight
    // host compositions that do not mount the DSH credentials service.
    const ambient = process.env[ref];
    if (ambient !== undefined && ambient.length > 0) return ambient;
  }
  if (!isDefaultRef) {
    throw new Error('Configured gateway credential reference could not be resolved');
  }
  return DEFAULT_API_KEY;
}

export function apply(ctx: Context, config: Config): void {
  const baseUrl = configuredBaseUrl(config);
  // Adapter clients resolve the active reference and volatile base URL at
  // request time. This keeps SettingsForms edits effective without a restart.
  const resolveGateway = async (): Promise<{ baseUrl: string; apiKey: string }> => ({
    baseUrl: configuredBaseUrl(config),
    apiKey: await resolveApiKey(ctx, config),
  });

  // Image bridge: read attachment bytes through the attachment service so
  // native image-capable models receive real image content. Resolved at call
  // time via ctx.get (not inject) so a missing service degrades to a clear
  // UNSUPPORTED_CONTENT error instead of blocking plugin load.
  const readImage = async (
    attachment: unknown,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> => {
    const attachments = ctx.get('attachments') as
      | { readImage?: (ref: unknown) => Promise<{ data: Uint8Array; ref: { mediaType: string } }> }
      | undefined;
    if (attachments?.readImage === undefined) return undefined;
    try {
      const stored = await attachments.readImage(attachment);
      return { data: stored.data, mediaType: stored.ref.mediaType };
    } catch {
      return undefined;
    }
  };

  const adapter = new XuedinerApiAdapter({
    baseUrl,
    apiKey: DEFAULT_API_KEY,
    resolveGateway,
    readImage,
  });

  const loaderFiber = ctx.fiber as typeof ctx.fiber & { entry?: { options?: { id?: string } } };
  const settingsNs = loaderFiber.entry?.options?.id ?? name;
  ctx.llm.registerConfigurableProviders([
    {
      provider: PROVIDER,
      displayName: 'xuedinerAPI',
      settingsNs,
      settingsPath: [],
    },
  ]);
  ctx.llm.registerAdapter([PROVIDER], adapter);
  ctx.logger.info(`[xuedinerAPI] provider "${PROVIDER}" registered`);

  // Optional host services mount in child fibers so absence cannot block the
  // core provider and disposal removes their registrations.
  ctx.inject(['commands'], child => registerPoolCommand(child));
  ctx.inject(['webServer'], child => registerPoolRoute(child));
}
