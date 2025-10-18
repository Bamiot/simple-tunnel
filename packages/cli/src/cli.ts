#!/usr/bin/env node
import { Command } from 'commander';
import { WebSocket } from 'ws';
import { Packr, Unpackr } from 'msgpackr';
import kleur from 'kleur';
import ora from 'ora';
import { FrameType, PROTOCOL_VERSION } from '@simple-tunnel/protocol';
import { request } from 'undici';
import { PassThrough } from 'stream';

const program = new Command();

program
  .name('simple-tunnel')
  .description('Expose a local port via a self-hosted reverse tunnel')
  .option('-p, --port <number>', 'Local port to expose', (v) => parseInt(v, 10))
  .option('-h, --host <host>', 'Local host to connect', '127.0.0.1')
  .option('-s, --subdomain <name>', 'Requested subdomain')
  .option(
    '-c, --connect <url>',
    'Control endpoint URL',
    process.env.SIMPLE_TUNNEL_CONNECT || 'ws://localhost:3000/connect'
  )
  .option('--domain-base <domain>', 'Base domain for public URL (fallbacks to connect host)', process.env.SIMPLE_TUNNEL_DOMAIN_BASE || process.env.DOMAIN_BASE)
  .option('-t, --token <token>', 'Auth token')
  .parse(process.argv);

const opts = program.opts<{ port?: number; host: string; subdomain?: string; connect: string; token?: string; domainBase?: string }>();
// Fallback: accept positional args [port, connect, subdomain] when flags are stripped by npm on Windows
const rest = program.args as string[];
if ((!opts.port || Number.isNaN(opts.port)) && rest[0]) {
  const n = parseInt(rest[0], 10);
  if (!Number.isNaN(n)) opts.port = n;
}
// Positional args override defaults/env when present
if (rest[1]) opts.connect = rest[1];
if (rest[2]) opts.subdomain = rest[2];

if (!opts.port || Number.isNaN(opts.port)) {
  console.error(kleur.red('Error: port is required (use --port or positional: <port> [connect] [subdomain])'));
  process.exit(1);
}

const spinner = ora('Connecting to server').start();

const packr = new Packr();
const unpackr = new Unpackr();

const connectURL = opts.connect;
console.log(kleur.gray(`Connect URL: ${connectURL}`));
const ws = new WebSocket(connectURL);
// Connection timeout to avoid silent hangs
const connTimer = setTimeout(() => {
  spinner.fail('Timeout connecting to server');
  console.error(kleur.yellow('Tips: ensure the server is running and reachable at the URL above. If using npm on Windows, pass arguments as positionals: <port> <connect> [subdomain].'));
}, 8000);
type StreamCtx = {
  mode: 'stream' | 'buffer';
  body?: PassThrough;
  chunks?: Buffer[];
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  tunnelId?: string;
};
const streams = new Map<number, StreamCtx>();

ws.on('open', () => {
  clearTimeout(connTimer);
  spinner.text = 'Authenticating and registering tunnel';
  send({ t: FrameType.HELLO, v: PROTOCOL_VERSION, token: opts.token });
  send({ t: FrameType.REGISTER_TUNNEL, subdomain: opts.subdomain });
});

ws.on('message', (data: Buffer) => {
  try {
    const msg = unpackr.unpack(data) as any;
    if (msg.t === FrameType.REGISTERED) {
      spinner.succeed('Tunnel registered');
      const baseFromOption = opts.domainBase;
      const baseFromConnect = new URL(opts.connect).host;
      const domainBase = (baseFromOption && String(baseFromOption)) || baseFromConnect;
      const url = `https://${msg.subdomain}.${domainBase}`;
      console.log(kleur.green(`Public URL: ${url}`));
      console.log(kleur.gray(`Local target: http://${opts.host}:${opts.port}`));
    } else if (msg.t === FrameType.OPEN_STREAM) {
      const method = String(msg.method || 'GET').toUpperCase();
      const headers = (msg.headers || {}) as Record<string, string>;
      const contentType = (headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
      const path = msg.path || '/';
      const preferStream = process.env.SIMPLE_TUNNEL_STREAM === 'true';
      const shouldBuffer = !['GET', 'HEAD'].includes(method) && !preferStream;
      if (shouldBuffer) {
        streams.set(msg.streamId, { mode: 'buffer', chunks: [], headers, method, path, tunnelId: msg.tunnelId });
      } else {
        const bodyStream = new PassThrough();
        streams.set(msg.streamId, { mode: 'stream', body: bodyStream, headers, method, path, tunnelId: msg.tunnelId });
        void handleOpenStream(msg, bodyStream);
      }
    } else if (msg.t === FrameType.REQ_DATA) {
      const entry = streams.get(msg.streamId);
      if (!entry || !msg.chunk) return;
      const buf = Buffer.from(msg.chunk);
      if (entry.mode === 'buffer') {
        entry.chunks!.push(buf);
      } else if (entry.mode === 'stream' && entry.body) {
        entry.body.write(buf);
      }
      if (process.env.SIMPLE_TUNNEL_LOG === 'true') {
        const total = (entry.chunks?.reduce((n, b) => n + b.length, 0) ?? 0);
        console.log(kleur.gray(`[stream ${msg.streamId}] REQ_DATA +${buf.length} bytes, total=${total}`));
      }
    } else if (msg.t === FrameType.END && msg.phase === 'req') {
      const entry = streams.get(msg.streamId);
      if (!entry) return;
      if (entry.mode === 'buffer') {
        if (process.env.SIMPLE_TUNNEL_LOG === 'true') {
          const total = Buffer.concat(entry.chunks || []).length;
          console.log(kleur.gray(`[stream ${msg.streamId}] REQ END, buffered=${total} bytes`));
        }
        void handleBufferedRequest(msg.streamId, entry);
      } else if (entry.mode === 'stream' && entry.body) {
        entry.body.end();
      }
    }
  } catch (e) {
    spinner.fail('Failed to parse server message');
  }
});

ws.on('close', () => {
  clearTimeout(connTimer);
  console.log(kleur.yellow('Disconnected.'));
});

ws.on('error', (err) => {
  clearTimeout(connTimer);
  spinner.fail('Connection error');
  console.error(err);
});

function send(frame: any) {
  ws.send(packr.pack(frame));
}

async function handleOpenStream(msg: any, bodyStream?: PassThrough) {
  try {
    const localUrl = `http://${opts.host}:${opts.port}${msg.path || '/'}`;
    const headers: Record<string, string> = { ...(msg.headers || {}) } as any;
    // Preserve upstream compression for better asset load (fonts, etc.)
    if (process.env.SIMPLE_TUNNEL_FORCE_IDENTITY === 'true') {
      headers['accept-encoding'] = 'identity';
    } else {
      // Allow upstream to choose compression; avoid overriding accept-encoding
      delete (headers as any)['accept-encoding'];
    }
    const method = String(msg.method || 'GET').toUpperCase();
    const streamRef = bodyStream ?? new PassThrough();
    if (!bodyStream) streams.set(msg.streamId, { mode: 'stream', body: streamRef, headers, method, path: msg.path, tunnelId: msg.tunnelId });
    const { statusCode, headers: respHeaders, body } = await request(localUrl, {
      method: method as any,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : streamRef
    });
    // Send response start (status + headers)
    ws.send(packr.pack({ t: FrameType.RESP_START, tunnelId: msg.tunnelId, streamId: msg.streamId, statusCode, headers: objectifyHeaders(respHeaders) } as any));
    // Stream response body
    for await (const chunk of body as any as AsyncIterable<Buffer>) {
      if (chunk && chunk.length) {
        ws.send(packr.pack({ t: FrameType.RESP_DATA, tunnelId: msg.tunnelId, streamId: msg.streamId, chunk } as any));
      }
    }
    ws.send(packr.pack({ t: FrameType.END, tunnelId: msg.tunnelId, streamId: msg.streamId, phase: 'res' } as any));
  } catch (e) {
    ws.send(packr.pack({ t: FrameType.RESP_START, tunnelId: msg.tunnelId, streamId: msg.streamId, statusCode: 502 } as any));
    ws.send(packr.pack({ t: FrameType.END, tunnelId: msg.tunnelId, streamId: msg.streamId, phase: 'res' } as any));
  }
}

async function handleBufferedRequest(streamId: number, entry: StreamCtx) {
  try {
    const localUrl = `http://${opts.host}:${opts.port}${entry.path || '/'}`;
    const headers: Record<string, string> = { ...(entry.headers || {}) } as any;
    if (process.env.SIMPLE_TUNNEL_FORCE_IDENTITY === 'true') {
      headers['accept-encoding'] = 'identity';
    } else {
      delete (headers as any)['accept-encoding'];
    }
    const bodyBuf = Buffer.concat(entry.chunks || []);
    headers['content-length'] = String(bodyBuf.length);
    const method = (entry.method || 'POST').toUpperCase();
    const { statusCode, headers: respHeaders, body } = await request(localUrl, {
      method: method as any,
      headers,
      body: bodyBuf
    });
    ws.send(packr.pack({ t: FrameType.RESP_START, tunnelId: entry.tunnelId, streamId, statusCode, headers: objectifyHeaders(respHeaders) } as any));
    for await (const chunk of body as any as AsyncIterable<Buffer>) {
      if (chunk && chunk.length) {
        ws.send(packr.pack({ t: FrameType.RESP_DATA, tunnelId: entry.tunnelId, streamId, chunk } as any));
      }
    }
    ws.send(packr.pack({ t: FrameType.END, tunnelId: entry.tunnelId, streamId, phase: 'res' } as any));
  } catch (e) {
    ws.send(packr.pack({ t: FrameType.RESP_START, tunnelId: entry.tunnelId, streamId, statusCode: 502 } as any));
    ws.send(packr.pack({ t: FrameType.END, tunnelId: entry.tunnelId, streamId, phase: 'res' } as any));
  } finally {
    streams.delete(streamId);
  }
}

function objectifyHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  // undici headers is an iterator of [key, value]
  try {
    for (const [k, v] of h as any) {
      if (typeof k === 'string' && typeof v === 'string') out[k] = v;
    }
  } catch {}
  return out;
}
