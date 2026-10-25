import { createHash } from 'node:crypto';
export function providerIdentity(provider) { return typeof provider?.accountUserId === 'string' && provider.accountUserId ? provider.accountUserId : null; }
export function providerConnectionId(provider) {
  if (!provider?.sessionId) return null;
  return createHash('sha256').update(JSON.stringify([provider.sessionId, provider.accountUserId || '', provider.connectedAt || 0, provider.sdkValidatedAt || 0, provider.connectionRevision || ''])).digest('hex').slice(0, 24);
}
export function sdkReady(provider) { return Boolean(provider?.sdkAccessToken && !provider.playbackNeedsReconnect && (Number.isFinite(provider.sdkExpiresAt) ? provider.sdkExpiresAt > Date.now() : provider.sdkSource === 'installed-client' && provider.sdkValidatedAt)); }
export function providerStatus(provider) {
  const connected = Boolean(provider?.sessionId && !provider.needsReconnect), playback = connected && sdkReady(provider);
  return { connected, user: provider?.user || null, accountId: providerIdentity(provider), connectionId: providerConnectionId(provider),
    sdkConnected: playback, sdkExpiresAt: provider?.sdkExpiresAt || null, needsReconnect: Boolean(provider?.needsReconnect),
    connectionMode: 'saved-account', playbackReady: playback,
    authorizationState: !provider?.sessionId ? 'disconnected' : provider.needsReconnect ? 'reconnect-required' : !playback ? 'playback-required' : 'ready',
    automaticRenewal: false };
}
