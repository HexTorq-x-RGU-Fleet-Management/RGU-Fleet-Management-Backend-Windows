import { createHash } from 'node:crypto';
import {
  providerStatus as baseStatus,
  sdkReady,
} from '../vendor/windows-sdk/lib/provider-state.mjs';
export { sdkReady };
export const providerVersion = (p) => p?.credentialVersion || p?.connectionRevision || null;
export function providerConnectionId(provider) {
  if (!provider?.sessionId) return null;
  return createHash('sha256')
    .update(
      JSON.stringify([
        provider.accountUserId || '',
        provider.connectionRevision || provider.connectedAt || provider.sessionId,
      ]),
    )
    .digest('hex')
    .slice(0, 24);
}
export function expiryHint(token) {
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
    return Number.isFinite(value.exp) && value.exp > 0 ? value.exp * 1000 : null;
  } catch {
    return null;
  }
}
export function providerStatus(provider) {
  const status = baseStatus(provider),
    r = provider?.recovery || {};
  const publicState = (value) => ({
    blocked: value?.blocked || null,
    nextRetryAt: value?.nextRetryAt || null,
    lastCheckedAt: value?.lastCheckedAt || null,
    lastRecoveredAt: value?.lastRecoveredAt || null,
  });
  return {
    ...status,
    connectionId: providerConnectionId(provider),
    automaticRenewal: false,
    automaticReconnect: Boolean(r.webEnabled && r.secret),
    recovery: {
      webEnabled: Boolean(r.webEnabled && r.secret),
      playbackEnabled: Boolean(r.playbackEnabled),
      running: Boolean(r.lease?.until > Date.now()),
      web: publicState(r.web),
      playback: publicState(r.playback),
    },
  };
}
