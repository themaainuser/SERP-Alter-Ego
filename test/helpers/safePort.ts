import type { Server } from 'node:http';

/**
 * The WHATWG fetch spec's blocked-port list: undici and Chrome refuse to talk to these
 * ("TypeError: fetch failed" / "Error: bad port"), while `netstat`-level connections work —
 * so a test server that lands on one fails with an unrelated-looking 503/UPSTREAM_NETWORK_ERROR.
 * Ephemeral allocation can genuinely hand out the >=1024 entries on machines whose TCP dynamic
 * range starts at 1024 (a non-default Windows configuration), so tests must not gamble on
 * `listen(0)`. The full list is kept even though ports below 1024 are unbindable here.
 */
const BAD_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000,
  6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
]);

export const isBadPort = (port: number): boolean => BAD_PORTS.has(port);

/**
 * Bind an ephemeral port and return it, closing and re-listening when the OS hands out a
 * port fetch forbids. (Windows allocates its dynamic range sequentially per process, so a
 * short retry loop lands outside any bad-port cluster.)
 */
export async function listenSafe(server: Server, host = '127.0.0.1'): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(0, host, () => {
        server.off('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') reject(new Error('failed to bind an ephemeral port'));
        else resolve(address.port);
      });
    });
    if (!isBadPort(port)) return port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  throw new Error('could not bind a fetch-allowed ephemeral port');
}
