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
const streams = new Map<number, { body: PassThrough }>();

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
      void handleOpenStream(msg);
    } else if (msg.t === FrameType.REQ_DATA) {
      const entry = streams.get(msg.streamId);
      if (entry && msg.chunk) entry.body.write(Buffer.from(msg.chunk));
    } else if (msg.t === FrameType.END && msg.phase === 'req') {
      const entry = streams.get(msg.streamId);
      if (entry) entry.body.end();
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

async function handleOpenStream(msg: any) {
  try {
    const localUrl = `http://${opts.host}:${opts.port}${msg.path || '/'}`;
    const headers = msg.headers || {};
    const method = String(msg.method || 'GET').toUpperCase();
    const bodyStream = new PassThrough();
    streams.set(msg.streamId, { body: bodyStream });
    const { statusCode, headers: respHeaders, body } = await request(localUrl, {
      method: method as any,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : bodyStream,
      // Preserve upstream compression so headers/content-encoding match the body
      decompress: false
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
