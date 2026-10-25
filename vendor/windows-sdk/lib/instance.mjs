import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AccountError } from './accounts.mjs';

// A Windows named pipe prevents two server processes from writing one vault,
// even if they choose different HTTP ports. It disappears when the process exits.
export function acquireInstance(directory) {
  const name = createHash('sha256').update(path.resolve(directory).toLowerCase()).digest('hex').slice(0, 24);
  return new Promise((resolve, reject) => {
    const guard = net.createServer(socket => socket.destroy());
    guard.once('error', () => reject(new AccountError('A viewer is already running for this account store, or Windows could not reserve it.', 503)));
    guard.listen('\\\\.\\pipe\\hikvision-windows-v2-' + name, () => resolve(guard));
  });
}
