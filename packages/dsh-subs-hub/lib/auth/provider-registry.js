/** Register one subscription adapter without replacing an existing route owner. */
export function registerSubscriptionAdapter(ctx, handles, provider, adapter, onWarn) {
	if (ctx.llm.listProviders().some((entry) => entry.id === provider)) {
		onWarn(`provider route "${provider}" is already registered (including any active llm-pi-ai profile); its subscription adapter was skipped to preserve the existing owner.`);
		return;
	}
	try {
		const handle = ctx.llm.registerAdapter([provider], adapter);
		handles.set(provider, handle);
		try {
			// The registration handle is the authoritative disposer. Bind it to
			// the owning plugin effect so disabling this plugin releases the route.
			ctx.effect(() => () => {
				handle();
				if (handles.get(provider) === handle) handles.delete(provider);
			}, `dsh-plugin-subscriptions: ${provider} adapter`);
		} catch (error) {
			handle();
			if (handles.get(provider) === handle) handles.delete(provider);
			throw error;
		}
	} catch (error) {
		if (error?.code !== "DUPLICATE_ADAPTER") throw error;
		onWarn(`provider route "${provider}" was claimed during registration; its subscription adapter was skipped.`);
	}
}
