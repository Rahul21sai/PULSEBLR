import crypto from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import webpush from 'web-push';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isKnownPushServiceHost,
  PRODUCTION_PUSH_TRANSPORT,
  PUSH_RESPONSE_MAX_BYTES,
  pushEndpointRefusal,
  sendPushRequest,
  sendToDeviceVia,
  type PushTransport,
} from '@/lib/notifications/push-transport';

/**
 * The push transport, driven against a real TLS server on 127.0.0.1.
 *
 * ── NOTHING HERE LEAVES THE MACHINE. ─────────────────────────────────────────────────────────
 * The stub is called `push.test`. `.test` is reserved (RFC 6761) and never resolves, so every send
 * below that succeeds also proves the socket went to the PINNED address: had the transport asked DNS
 * a second time it would have got ENOTFOUND. Five fields of the transport differ from production,
 * and `stub()` names each: the host policy (the stub's name and port, not the push-service list), the
 * resolver (its address, not DNS), the address policy (loopback, which production refuses), the trust
 * store (its certificate and nothing else) and the deadlines (short enough to wait out). Everything
 * else runs unmodified: the canonical-form rule, the timers, the byte cap, the refusal to follow a
 * redirect, TLS verification, and the translation into a `DeviceSendResult`.
 *
 * ── THE CERTIFICATE IS MINTED PER RUN, NOT COMMITTED. ────────────────────────────────────────
 * Node can make a key but not a certificate. A PEM fixture would put a private key in the repository
 * for every secret scanner to flag, and give the suite an expiry date to go red on. So
 * `selfSignedCertificate` writes the few dozen bytes of DER an X.509 v3 certificate needs and signs
 * them with a fresh P-256 key, valid 2000 to 2125 so a skewed clock cannot fail it either.
 */

/* ── A self-signed certificate, in DER ──────────────────────────────────────────────────────── */

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function der(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const hex = (value: string) => Buffer.from(value, 'hex');
const sequence = (...content: Buffer[]) => der(0x30, ...content);
const ECDSA_WITH_SHA256 = sequence(hex('06082a8648ce3d040302'));
const commonName = (name: string) =>
  sequence(der(0x31, sequence(hex('0603550403'), der(0x0c, Buffer.from(name)))));

/** UTCTime before 2050 and GeneralizedTime from 2050 on, as RFC 5280 requires. */
function time(at: string): Buffer {
  const date = new Date(at);
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : der(0x18, Buffer.from(`${digits}Z`));
}

function selfSignedCertificate(hostname: string): { cert: string; key: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const tbs = sequence(
    der(0xa0, hex('020102')), // version 3
    hex('020101'), // serial 1
    ECDSA_WITH_SHA256,
    commonName(hostname), // issuer
    sequence(time('2000-01-01T00:00:00Z'), time('2125-12-31T23:59:59Z')),
    commonName(hostname), // subject: the same, it signs itself
    publicKey.export({ type: 'spki', format: 'der' }),
    der(
      0xa3,
      sequence(
        // basicConstraints, critical, CA:TRUE, so it can be its own trust anchor
        sequence(hex('0603551d13'), hex('0101ff'), der(0x04, sequence(hex('0101ff')))),
        // subjectAltName, one dNSName, which is what TLS actually checks the host against
        sequence(hex('0603551d11'), der(0x04, sequence(der(0x82, Buffer.from(hostname))))),
      ),
    ),
  );
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, der(0x03, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
  const base64 = (certificate.toString('base64').match(/.{1,64}/g) ?? []).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/* ── The stub push service ──────────────────────────────────────────────────────────────────── */

const HOST = 'push.test';
const TOPIC = '68b1f0c4a1b2c3d4e5f60718';
const PAYLOAD = JSON.stringify({ title: 'Test', body: 'Body', url: '/events/x', tag: 'pblr-event-x' });
const FCM_GONE = 'push subscription has unsubscribed or expired.';
const TEN_MB = 10 * 1024 * 1024;
const CHUNK = Buffer.alloc(64 * 1024, 'x');
const HOSTILE = 'boom\r\n  sent   forged@example.com\x1b[2J\x1b]52;c;ZXZpbA==\x07\n::error::forged ##[add-mask]x';

/** Nothing a terminal acts on. The same definition `tests/push-policy.test.ts` uses. */
const INERT = /^[^\x00-\x1f\x7f-\x9f\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}]*$/u;

interface Seen {
  path: string;
  method: string;
  headers: IncomingHttpHeaders;
  bodyBytes: number;
}
/** Every request the stub finished reading, in order. Reset before each test. */
const seen: Seen[] = [];
/** What the 10 MB route managed to do before the client went away. */
const huge = { attempted: 0, finished: false, closed: false };

let certificate: { cert: string; key: string };
let server: https.Server;
let port = 0;
/** Accepts TCP and never speaks: a TLS handshake against it cannot complete. */
let mute: net.Server;
let mutePort = 0;
const muted = new Set<net.Socket>();
let subscriberKeys: { p256dh: string; auth: string };

/** A 500 with a 10 MB body, written only as fast as the client reads it. */
function streamHuge(res: ServerResponse): void {
  huge.attempted = 0;
  huge.finished = false;
  huge.closed = false;
  res.on('finish', () => {
    huge.finished = true;
  });
  res.on('close', () => {
    huge.closed = true;
  });
  res.writeHead(500, { 'content-type': 'text/plain' });
  const pump = () => {
    while (huge.attempted < TEN_MB && !res.destroyed) {
      huge.attempted += CHUNK.length;
      if (!res.write(CHUNK)) {
        res.once('drain', pump);
        return;
      }
    }
    if (!res.destroyed) res.end();
  };
  pump();
}

/**
 * A 201, then a body that never ends, dripped slowly on purpose: 16 bytes every 50 ms would take
 * over 12 s to fill the 4 KB cap, so a sender that read a 2xx body at all could only finish on its
 * deadline. Only answering at the status line is fast.
 */
function streamForever(res: ServerResponse): void {
  res.writeHead(201, { 'content-type': 'text/plain' });
  const timer = setInterval(() => {
    if (!res.destroyed) res.write(CHUNK.subarray(0, 16));
  }, 50);
  res.on('close', () => clearInterval(timer));
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0];
  const body: Buffer[] = [];
  req.on('data', (chunk: Buffer) => body.push(chunk));
  req.on('end', () => {
    seen.push({ path, method: req.method ?? '', headers: req.headers, bodyBytes: Buffer.concat(body).length });

    const status = /^\/status\/(\d{3})$/.exec(path);
    if (status) {
      res.writeHead(Number(status[1]), { 'content-type': 'text/plain' });
      res.end(`status ${status[1]}`);
      return;
    }
    const redirect = /^\/redirect\/(\d{3})$/.exec(path);
    if (redirect) {
      res.writeHead(Number(redirect[1]), { location: `https://${HOST}:${port}/loot` });
      res.end('moved');
      return;
    }
    switch (path) {
      case '/gone':
        res.writeHead(410, { 'content-type': 'text/plain' });
        res.end(`${FCM_GONE}\n`);
        return;
      case '/huge':
        streamHuge(res);
        return;
      case '/accepted-then-endless':
        streamForever(res);
        return;
      case '/hostile':
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(HOSTILE);
        return;
      case '/cut-short':
        // Promises 1000 bytes, sends 7, then hangs up.
        res.writeHead(500, { 'content-type': 'text/plain', 'content-length': '1000' });
        res.write('partial');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      case '/silent':
        // Reads the whole request and never answers.
        return;
      default:
        res.writeHead(201);
        res.end();
    }
  });
}

beforeAll(async () => {
  certificate = selfSignedCertificate(HOST);
  server = https.createServer({ key: certificate.key, cert: certificate.cert }, route);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  mute = net.createServer(socket => {
    muted.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => muted.delete(socket));
  });
  await new Promise<void>(resolve => mute.listen(0, '127.0.0.1', resolve));
  mutePort = (mute.address() as AddressInfo).port;

  // `generateRequestDetails` reads the VAPID pair from web-push's module state, which is what
  // `configureWebPush()` sets in production.
  const vapid = webpush.generateVAPIDKeys();
  webpush.setVapidDetails('mailto:push-transport-test@example.com', vapid.publicKey, vapid.privateKey);

  // A real subscriber key pair, so the payload is genuinely encrypted on the way out.
  const subscriber = crypto.createECDH('prime256v1');
  subscriber.generateKeys();
  subscriberKeys = {
    p256dh: subscriber.getPublicKey().toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  };
});

afterAll(async () => {
  server.closeAllConnections();
  for (const socket of muted) socket.destroy();
  await Promise.all([
    new Promise<void>(resolve => server.close(() => resolve())),
    new Promise<void>(resolve => mute.close(() => resolve())),
  ]);
});

beforeEach(() => {
  seen.length = 0;
});

/** The stub's transport. Only these five fields differ from `PRODUCTION_PUSH_TRANSPORT`. */
function stub(overrides: Partial<PushTransport> = {}): PushTransport {
  return {
    ...PRODUCTION_PUSH_TRANSPORT,
    endpointRefusal: url => (url.hostname === HOST ? null : `"${url.hostname}" is not the stub`),
    resolve: async () => ['127.0.0.1'],
    addressAllowed: () => true,
    ca: certificate.cert,
    connectTimeoutMs: 1_000,
    totalTimeoutMs: 2_000,
    ...overrides,
  };
}

function device(path: string, host = HOST, onPort = port) {
  return { endpoint: `https://${host}:${onPort}${path}`, ...subscriberKeys };
}

function send(target: { endpoint: string; p256dh: string; auth: string }, transport: PushTransport = stub()) {
  return sendToDeviceVia(transport, target, PAYLOAD, TOPIC);
}

async function until(done: () => boolean, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  while (!done() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
}

/* ── The tests ─────────────────────────────────────────────────────────────────────────────── */

describe('a push service that behaves', () => {
  it('delivers: 201, at the pinned address, with exactly the request web-push built', async () => {
    const lookups: string[] = [];
    const target = device('/ok');
    const result = await send(
      target,
      stub({
        resolve: async hostname => {
          lookups.push(hostname);
          return ['127.0.0.1'];
        },
      })
    );

    expect(result).toStrictEqual({ endpoint: target.endpoint, ok: true, status: 201 });
    // Asked once, and the connection used the answer: `push.test` has no other way to reach 127.0.0.1.
    expect(lookups).toEqual([HOST]);

    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request.method).toBe('POST');
    expect(request.headers.host).toBe(`${HOST}:${port}`);
    expect(request.headers.ttl).toBe(String(12 * 3600));
    expect(request.headers.urgency).toBe('high');
    expect(request.headers.topic).toBe(TOPIC);
    expect(request.headers['content-encoding']).toBe('aes128gcm');
    expect(request.headers['content-type']).toBe('application/octet-stream');
    expect(Number(request.headers['content-length'])).toBe(request.bodyBytes);
    expect(request.bodyBytes).toBeGreaterThan(Buffer.byteLength(PAYLOAD));

    // The VAPID JWT names the endpoint's own origin, so it cannot be replayed at a real push service.
    const jwt = /^vapid t=([^,]+), k=/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'));
    expect(claims.aud).toBe(`https://${HOST}:${port}`);
  });

  it('reports a 410 as gone, with the push service wording', async () => {
    const target = device('/gone');
    expect(await send(target)).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      status: 410,
      gone: true,
      error: `410 ${FCM_GONE}`,
    });
  });

  it.each([
    [404, true],
    [429, false],
    [500, false],
    [503, false],
  ])('reports a %i with gone=%s', async (code, gone) => {
    const target = device(`/status/${code}`);
    expect(await send(target)).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      status: code,
      gone,
      error: `${code} status ${code}`,
    });
  });
});

describe('a push service that does not', () => {
  it('stops reading a 10 MB error body at the cap, and still reports a clean failure', async () => {
    const target = device('/huge');
    const result = await send(target);

    expect(result).toMatchObject({ endpoint: target.endpoint, ok: false, status: 500, gone: false });
    // `toLogLine` keeps 200 code points of the capped body, ellipsis included.
    expect(result.error).toBe(`500 ${'x'.repeat(199)}…`);

    // The socket was DESTROYED, not merely ignored: the stub never got to send the rest.
    await until(() => huge.closed, 2_000);
    expect(huge.closed).toBe(true);
    expect(huge.finished).toBe(false);
    expect(huge.attempted).toBeLessThan(TEN_MB);
  });

  it('keeps exactly the cap of that body, and says it was cut', async () => {
    const response = await sendPushRequest(
      { method: 'POST', headers: {}, body: null, endpoint: device('/huge').endpoint },
      stub()
    );
    expect(response).toMatchObject({ statusCode: 500, bodyBytes: PUSH_RESPONSE_MAX_BYTES, truncated: true });
    expect(response.body).toBe('x'.repeat(PUSH_RESPONSE_MAX_BYTES));
  });

  it('turns a hostile error body into one inert line', async () => {
    const result = await send(device('/hostile'));
    expect(result.status).toBe(500);
    expect(result.error?.startsWith('500 boom ')).toBe(true);
    expect(result.error).toMatch(INERT);
    expect(result.error).not.toContain('##[');
  });

  it('keeps the status of a body the peer cut short, without waiting for the deadline', async () => {
    const target = device('/cut-short');
    const started = Date.now();
    const result = await send(target, stub({ totalTimeoutMs: 3_000 }));
    expect(result).toStrictEqual({ endpoint: target.endpoint, ok: false, status: 500, gone: false, error: '500 partial' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('gives up on a peer that reads the request and never answers', async () => {
    const target = device('/silent');
    const started = Date.now();
    const result = await send(target, stub({ connectTimeoutMs: 300, totalTimeoutMs: 600 }));
    const elapsed = Date.now() - started;

    expect(result).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      error: 'the push service did not answer within 600 ms',
    });
    expect(elapsed).toBeGreaterThanOrEqual(550);
    expect(elapsed).toBeLessThan(2_000);
    // It did get there: this deadline is about the answer, not the connection.
    expect(seen.map(request => request.path)).toEqual(['/silent']);
  });

  it('gives up on a peer that takes the connection and never completes TLS', async () => {
    const target = device('/x', HOST, mutePort);
    const started = Date.now();
    const result = await send(target, stub({ connectTimeoutMs: 300, totalTimeoutMs: 1_500 }));
    const elapsed = Date.now() - started;

    expect(result).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      error: 'could not connect to the push service within 300 ms',
    });
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_200);
  });

  it('counts DNS against the same deadline', async () => {
    const target = device('/ok');
    const result = await send(target, stub({ resolve: () => new Promise<string[]>(() => {}), totalTimeoutMs: 400 }));
    expect(result).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      error: 'the push service did not answer within 400 ms',
    });
    expect(seen).toEqual([]);
  });

  it('takes a 2xx at its status line and never reads the body behind it', async () => {
    const target = device('/accepted-then-endless');
    const started = Date.now();
    const result = await send(target, stub({ totalTimeoutMs: 3_000 }));
    expect(result).toStrictEqual({ endpoint: target.endpoint, ok: true, status: 201 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it.each([301, 302, 303, 307, 308])('does not follow a %i', async code => {
    const target = device(`/redirect/${code}`);
    expect(await send(target)).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      status: code,
      gone: false,
      error: `${code} moved`,
    });
    // The `Location` was never fetched.
    expect(seen.map(request => request.path)).toEqual([`/redirect/${code}`]);
  });

  it('refuses a certificate nothing vouches for', async () => {
    // `ca` unset means the default trust store, exactly as in production, and nothing in it signed this.
    const result = await send(device('/ok'), stub({ ca: undefined }));
    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.error).toMatch(/self-signed certificate/);
    expect(seen).toEqual([]);
  });

  it('refuses a trusted certificate that names a different host', async () => {
    const result = await send(device('/ok', 'other.test'), stub({ endpointRefusal: () => null }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/altnames/);
    expect(seen).toEqual([]);
  });
});

describe('who may be contacted', () => {
  it.each([
    'fcm.googleapis.com',
    'jmt17.google.com',
    'android.googleapis.com',
    'updates.push.services.mozilla.com',
    'updates-autopush.stage.mozaws.net',
    'updates-autopush.dev.mozaws.net',
    'wns2-par02p.notify.windows.com',
    'db5p.notify.windows.com',
    'web.push.apple.com',
    'FCM.GoogleAPIs.com',
  ])('knows %s', host => {
    expect(isKnownPushServiceHost(host)).toBe(true);
  });

  it.each([
    ['attacker.example', 'an arbitrary host'],
    ['fcm.googleapis.com.attacker.example', "a listed name at the front of somebody else's"],
    ['x.fcm.googleapis.com', 'a subdomain of an exact name'],
    ['fcm.googleapis.com.', 'the trailing-dot spelling'],
    ['notify.windows.com', 'a wildcard parent itself'],
    ['evilnotify.windows.com', 'a wildcard parent without its dot'],
    ['a.b.notify.windows.com', 'two labels under a one-label wildcard'],
    ['-x.notify.windows.com', 'a label no hostname can have'],
    ['x_y.push.apple.com', 'an underscore'],
    ['push.apple.com', "Apple's parent itself"],
    ['web.push.apple.com.attacker.example', 'a vendor name as a prefix'],
    ['169.254.169.254', 'an address'],
    ['', 'nothing'],
  ])('refuses %s (%s)', host => {
    expect(isKnownPushServiceHost(host)).toBe(false);
  });

  it('accepts a real endpoint from each vendor', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/dOFzS9V3xkM:APA91bF-3s7pQ',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAABk',
      'https://web.push.apple.com/QGuQyavXutnMH',
    ]) {
      expect(pushEndpointRefusal(new URL(endpoint))).toBeNull();
    }
  });

  /*
   * PRODUCTION's policy, with only `resolve` swapped for a spy. Every one of these must be refused
   * before any lookup, which is what the empty spy proves, so none can have reached a socket.
   */
  it.each([
    ['https://attacker.example/fcm/send/x', '"attacker.example" is not a known push service'],
    ['https://localhost/push', '"localhost" is not a known push service'],
    ['https://[::1]/push', '"[::1]" is not a known push service'],
    ['https://127.0.0.1;.attacker.example/x', '"127.0.0.1;.attacker.example" is not a known push service'],
    // The parser split the header describes: `new URL` and `url.parse` disagree on the host.
    ['https://169.254.169.254%2eattacker.example/fcm/send/x', 'the endpoint is not written in canonical form'],
    // The allowlist alone would say yes to this one: `new URL` decodes the host to fcm.googleapis.com.
    ['https://fcm%2egoogleapis.com/fcm/send/x', 'the endpoint is not written in canonical form'],
    ['https://FCM.googleapis.com/fcm/send/x', 'the endpoint is not written in canonical form'],
    ['https://fcm.googleapis.com:443/fcm/send/x', 'the endpoint is not written in canonical form'],
    ['https://fcm.googleapis.com:8443/fcm/send/x', 'port 8443 is not the https default'],
    ['http://fcm.googleapis.com/fcm/send/x', 'the endpoint is not https'],
    ['https://user:pw@fcm.googleapis.com/fcm/send/x', 'the endpoint carries credentials'],
    ['fcm.googleapis.com/fcm/send/x', 'the endpoint is not a valid URL'],
  ])('refuses %s before any lookup', async (endpoint, reason) => {
    const lookups: string[] = [];
    const transport: PushTransport = {
      ...PRODUCTION_PUSH_TRANSPORT,
      resolve: async hostname => {
        lookups.push(hostname);
        return ['127.0.0.1'];
      },
    };
    expect(await send({ endpoint, ...subscriberKeys }, transport)).toStrictEqual({
      endpoint,
      ok: false,
      error: `endpoint failed the SSRF check: ${reason}`,
    });
    expect(lookups).toEqual([]);
  });

  /*
   * PRODUCTION's address policy, with everything else the stub's. The loopback answer is listed
   * FIRST, so if the check were ever skipped the socket would reach the stub (and `seen` would say
   * so) rather than anywhere off this machine.
   */
  it.each([
    [['127.0.0.1'], 'the host resolves to a non-public address'],
    [['127.0.0.1', '203.0.113.10'], 'the host resolves to a non-public address'],
    [[], 'the host could not be resolved'],
  ])('refuses to connect when DNS answers %j', async (addresses, reason) => {
    const target = device('/ok');
    const transport = stub({
      resolve: async () => addresses,
      addressAllowed: PRODUCTION_PUSH_TRANSPORT.addressAllowed,
    });
    expect(await send(target, transport)).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      error: `endpoint failed the SSRF check: ${reason}`,
    });
    expect(seen).toEqual([]);
  });

  it('treats a failed lookup as a refusal of this device, not a crash', async () => {
    const target = device('/ok');
    const transport = stub({
      resolve: async () => {
        throw Object.assign(new Error('getaddrinfo ENOTFOUND push.test'), { code: 'ENOTFOUND' });
      },
    });
    expect(await send(target, transport)).toStrictEqual({
      endpoint: target.endpoint,
      ok: false,
      error: 'endpoint failed the SSRF check: the host could not be resolved',
    });
  });
});

describe('PRODUCTION_PUSH_TRANSPORT', () => {
  it('is frozen, trusts only the default store, and uses the production policy', () => {
    expect(Object.isFrozen(PRODUCTION_PUSH_TRANSPORT)).toBe(true);
    expect('ca' in PRODUCTION_PUSH_TRANSPORT).toBe(false);
    expect(PRODUCTION_PUSH_TRANSPORT.endpointRefusal).toBe(pushEndpointRefusal);
    expect(PRODUCTION_PUSH_TRANSPORT.maxResponseBytes).toBe(4096);
  });

  it('refuses private, loopback and metadata addresses and allows public ones', () => {
    const { addressAllowed } = PRODUCTION_PUSH_TRANSPORT;
    for (const address of ['127.0.0.1', '169.254.169.254', '10.0.0.7', '::1', '::ffff:7f00:1', 'not-an-ip']) {
      expect(addressAllowed(address)).toBe(false);
    }
    for (const address of ['142.250.183.10', '2607:f8b0:4004:c1b::5f']) {
      expect(addressAllowed(address)).toBe(true);
    }
  });

  it('has finite deadlines, the connect one inside the total', () => {
    const { connectTimeoutMs, totalTimeoutMs } = PRODUCTION_PUSH_TRANSPORT;
    expect(connectTimeoutMs).toBeGreaterThan(0);
    expect(connectTimeoutMs).toBeLessThan(totalTimeoutMs);
    expect(Number.isFinite(totalTimeoutMs)).toBe(true);
  });
});
