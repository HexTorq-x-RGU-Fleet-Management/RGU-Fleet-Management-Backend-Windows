// Read only the official SDK OAuth result, never arbitrary callback URLs.
// A web JWT is not an SDK token. SDK open_id can differ from the web user ID.
// Playback is restricted to the intersection of web-discovered channels and
// channels independently authorized by the SDK; this token grants no web access.
export function sdkSessionFromTargets(targets, account) {
  if (!account?.accountUserId) return null;
  for (const target of targets) {
    try {
      const url = new URL(target.url);
      if (target.type !== 'page' || url.origin !== 'https://iusopenauth.ezvizlife.com' || url.pathname !== '/custom/success') continue;
      const params = new URLSearchParams(url.hash.slice(1));
      if (params.get('areaDomain') !== 'https://iindiaopen.ezvizlife.com') continue;
      const token = params.get('access_token');
      if (!token || !/^at\.[A-Za-z0-9._-]{16,1024}$/.test(token)) continue;
      const expires = Number(params.get('expires_in'));
      if (!Number.isFinite(expires) || expires <= Date.now()) continue;
      return { sdkAccessToken: token, sdkExpiresAt: expires };
    } catch {}
  }
  return null;
}
