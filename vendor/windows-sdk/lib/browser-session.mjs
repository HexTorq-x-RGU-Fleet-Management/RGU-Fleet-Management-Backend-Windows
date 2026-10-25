import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { isPortalOrigin, portalOrigins } from './portal-origin.mjs';
import { sdkSessionFromTargets } from './sdk-session.mjs';
export class BrowserError extends Error {}
export const discoveryExpression = `(() => {
  if (!${JSON.stringify(portalOrigins)}.includes(location.origin) || !(location.pathname.startsWith('/views/main/') ||
    (location.pathname === '/views/login/index.html' && location.hash.startsWith('#/portal'))))
    return {error:'Open the signed-in Hik-Connect device portal first.'};
  const value = document.cookie.split('; ').find(item => item.startsWith('HC_sessionId='));
  let user = {}; try {user=JSON.parse(localStorage.getItem('hik_connect_user')||'{}')} catch {}
  if (!value) return {error:'Sign in to Hik-Connect in Chrome, then connect again.'};
  return {sessionId:decodeURIComponent(value.slice('HC_sessionId='.length)),origin:location.origin,accountUserId:user.userId||'',
    user:{username:user.username||'',email:user.email||'',country:user.country||'',areaId:user.areaId||null}};
})()`;

export function selectPortal(pages) {
  const valid = page => {
    try { const url = new URL(page.url); return page.type === 'page' && isPortalOrigin(url.origin) && (url.pathname.startsWith('/views/main/') ||
      (url.pathname === '/views/login/index.html' && url.hash.startsWith('#/portal'))); }
    catch { return false; }
  };
  return pages.find(page => valid(page) && new URL(page.url).origin === 'https://iindia.hik-connect.com') || pages.find(valid);
}
export function localDebugUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password)
    throw new BrowserError('Chrome debugging must use a local HTTP address.');
  return url;
}
async function inspect(endpoint, browserEndpoint, Socket = WebSocket) {
  return new Promise((resolve, reject) => {
    const socket = new Socket(endpoint);
    const timeout = setTimeout(() => finish(new BrowserError('Chrome did not answer. Check its connection approval prompt.')), 25000);
    let complete = false;
    let nextId = 0;
    const pending = new Map();
    const call = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    function finish(error, value) {
      if (complete) return; complete = true;
      clearTimeout(timeout); try { socket.close(); } catch {}
      for (const waiter of pending.values()) waiter.reject(new BrowserError('Chrome connection ended.'));
      pending.clear();
      error ? reject(error) : resolve(value);
    }
    socket.addEventListener('open', async () => {
      try {
        let targetSession;
        let targetPages = [];
        if (browserEndpoint) {
          const targets = await call('Target.getTargets');
          targetPages = targets.targetInfos || [];
          const page = selectPortal(targets.targetInfos || []);
          if (!page) throw new BrowserError('Open the signed-in Hik-Connect device portal in Chrome, then connect again.');
          targetSession = (await call('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
        }
        const result = await call('Runtime.evaluate', { expression: discoveryExpression, returnByValue: true, awaitPromise: true }, targetSession);
        if (result.exceptionDetails) throw new BrowserError('Could not read the Hik-Connect session. Sign in in Chrome and retry.');
        if (targetSession) await call('Target.detachFromTarget', { sessionId: targetSession });
        const account = result.result?.value;
        let sdk = sdkSessionFromTargets(targetPages, account);
        // Chrome can replace a vendor 404 callback URL with chrome-error://.
        // Inspect only that specific official-host error page, never other tabs.
        if (!sdk && browserEndpoint && account?.accountUserId) {
          const callback = targetPages.find(page => page.type === 'page' && page.url === 'chrome-error://chromewebdata/' && page.title === 'iusopenauth.ezvizlife.com');
          if (callback) {
            const sdkSession = (await call('Target.attachToTarget', { targetId: callback.targetId, flatten: true })).sessionId;
            try {
              const response = await call('Runtime.evaluate', { expression: `document.body.innerText.match(/https:\\/\\/iusopenauth\\.ezvizlife\\.com\\/custom\\/success#[^\\s]+/)?.[0] || null`, returnByValue: true }, sdkSession);
              sdk = sdkSessionFromTargets([{ type: 'page', url: response.result?.value }], account);
            } finally { await call('Target.detachFromTarget', { sessionId: sdkSession }); }
          }
        }
        finish(null, sdk ? { ...account, ...sdk } : account);
      } catch (error) { finish(error); }
    });
    socket.addEventListener('message', event => {
      let message; try { message = JSON.parse(String(event.data)); } catch { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new BrowserError('Chrome rejected the inspection request. Check its connection approval prompt.'));
      else waiter.resolve(message.result);
    });
    socket.addEventListener('error', () => finish(new BrowserError('Chrome denied the debugging connection. Check its approval prompt.')));
    socket.addEventListener('close', () => { if (!complete) finish(new BrowserError('Chrome closed the debugging connection.')); });
  });
}
async function activePort() {
  const file = process.env.CHROME_ACTIVE_PORT_FILE || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data/DevToolsActivePort')
    : path.join(homedir(), process.platform === 'darwin' ? 'Library/Application Support/Google/Chrome/DevToolsActivePort' : '.config/google-chrome/DevToolsActivePort'));
  return readFile(file, 'utf8');
}
export async function readBrowserSession({ debugUrl = 'http://127.0.0.1:9222', request = fetch, Socket = WebSocket, readActivePort = activePort } = {}) {
  const base = localDebugUrl(debugUrl);
  let response;
  try { response = await request(new URL('/json/list', base), { signal: AbortSignal.timeout(5000) }); }
  catch { throw new BrowserError('Chrome is unavailable. Open chrome://inspect/#remote-debugging and enable remote debugging.'); }
  let address, browserEndpoint = false, pages = [];
  if (response.ok) {
    pages = await response.json();
    const page = selectPortal(pages);
    if (!page) throw new BrowserError('Open the signed-in Hik-Connect device portal in Chrome, then connect again.');
    if (!page.webSocketDebuggerUrl) throw new BrowserError('Chrome did not expose this Hik-Connect tab for debugging.');
    address = page.webSocketDebuggerUrl;
  } else if (response.status === 404) {
    // Chrome's opt-in remote-debugging mode exposes a browser WebSocket but
    // intentionally omits the legacy HTTP discovery endpoints.
    let metadata;
    try { metadata = await readActivePort(); } catch { throw new BrowserError('Chrome endpoint metadata is unavailable. Check the debug port and Chrome profile.'); }
    const [port, endpointPath] = metadata.trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || port !== base.port || !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpointPath || ''))
      throw new BrowserError('Chrome debugging metadata does not match the configured local port.');
    address = `ws://${base.host}${endpointPath}`; browserEndpoint = true;
  } else throw new BrowserError('Chrome debugging is not available. Check the debugging setting and approval prompt.');
  const endpoint = new URL(address);
  if (endpoint.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new BrowserError('Chrome returned a non-local debugging endpoint.');
  const session = await inspect(endpoint.href, browserEndpoint, Socket);
  if (session?.error) throw new BrowserError('Sign in to the Hik-Connect device portal in Chrome, then connect again.');
  if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new BrowserError('No signed-in Hik-Connect session was found.');
  if (session.origin && !isPortalOrigin(session.origin)) throw new BrowserError('The Hik-Connect region is not supported by this workspace.');
  const sdk = sdkSessionFromTargets(pages, session);
  return sdk ? { ...session, ...sdk } : session;
}
