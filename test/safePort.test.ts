import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isBadPort, listenSafe } from './helpers/safePort.js';

describe('bad-port guard', () => {
  it('classifies the WHATWG blocked ports, including the ones an ephemeral range can hand out', () => {
    // The machine this flake was found on allocates its dynamic range from 1024, so the
    // >=1024 entries are the ones listen(0) can actually draw.
    for (const port of [2049, 3659, 4045, 4190, 5060, 5061, 6000, 6665, 6666, 6667, 6668, 6669, 6697, 10080]) {
      assert.equal(isBadPort(port), true, `${port} is on the WHATWG blocked list`);
    }
    for (const port of [80, 443, 3000, 3001, 8080, 49152]) {
      assert.equal(isBadPort(port), false, `${port} is fetch-allowed`);
    }
  });

  it('listenSafe binds a fetch-allowed port', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const port = await listenSafe(server);
    assert.ok(port > 0);
    assert.equal(isBadPort(port), false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
