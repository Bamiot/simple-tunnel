import Fastify from "fastify";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import underPressure from "@fastify/under-pressure";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  FrameType,
  isValidSubdomain,
} from "@simple-tunnel/protocol";
import { Packr, Unpackr } from "msgpackr";

const DOMAIN_BASE = process.env.DOMAIN_BASE || "localhost";
const PORT = Number(process.env.PORT || 3000);

type TunnelInfo = {
  ws: WebSocket;
  tunnelId: string;
  subdomain: string;
  createdAt: number;
  nextStreamId: number;
  streams: Map<
    number,
    { reply: any; timeout: NodeJS.Timeout; headersSent: boolean }
  >;
};

const tunnels = new Map<string, TunnelInfo>(); // key: subdomain

const packr = new Packr();
const unpackr = new Unpackr();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" } });

await app.register(underPressure);
await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
await app.register(websocket);

// log all requests, useful for debugging, can be activated via LOG_ALL_REQUESTS env var
if (process.env.LOG_ALL_REQUESTS === "true") {
  app.addHook("onRequest", async (req, reply) => {
    req.log.info(
      { method: req.method, url: req.url, headers: req.headers },
      "Incoming request"
    );
  });
}

app.get("/health", async () => ({ ok: true }));

// WebSocket control endpoint used by clients to open a tunnel
app.get("/connect", { websocket: true }, (socket: WebSocket, req) => {
  req.log.info({ ip: req.ip }, "WS connect");

  let assignedSubdomain: string | undefined;
  const tunnelId = `t_${Math.random().toString(36).slice(2, 10)}`;

  socket.on("message", (data: Buffer) => {
    try {
      const msg = unpackr.unpack(data) as any;
      switch (msg.t) {
        case FrameType.HELLO: {
          if (msg.v !== PROTOCOL_VERSION) {
            req.log.warn({ v: msg.v }, "Protocol version mismatch");
          }
          break;
        }
        case FrameType.REGISTER_TUNNEL: {
          const requested =
            msg.subdomain && isValidSubdomain(msg.subdomain)
              ? msg.subdomain
              : undefined;
          const sub =
            requested && !tunnels.has(requested)
              ? requested
              : generateRandomSubdomain();
          if (tunnels.has(sub)) {
            // extremely unlikely if random, ask client to retry with another sub
            send(socket, {
              t: FrameType.ERROR,
              code: "SUBDOMAIN_TAKEN",
              message: "Please retry",
            });
            return;
          }
          assignedSubdomain = sub;
          tunnels.set(sub, {
            ws: socket,
            tunnelId,
            subdomain: sub,
            createdAt: Date.now(),
            nextStreamId: 1,
            streams: new Map(),
          });
          send(socket, { t: FrameType.REGISTERED, subdomain: sub, tunnelId });
          req.log.info({ sub }, "Tunnel registered");
          break;
        }
        case FrameType.RESP_START: {
          const info = assignedSubdomain
            ? tunnels.get(assignedSubdomain)
            : undefined;
          if (!info) break;
          const { streamId, statusCode, headers } = msg as any;
          const entry = info.streams.get(streamId);
          if (!entry || entry.headersSent) break;
          entry.headersSent = true;
          try {
            const res = entry.reply.raw as import("http").ServerResponse;
            res.writeHead(statusCode || 200, normalizeHeaders(headers || {}));
          } catch (e) {
            req.log.error({ e }, "Failed to write response head");
          }
          break;
        }
        case FrameType.RESP_DATA: {
          const info = assignedSubdomain
            ? tunnels.get(assignedSubdomain)
            : undefined;
          if (!info) break;
          const { streamId, chunk } = msg as any;
          const entry = info.streams.get(streamId);
          if (!entry) break;
          try {
            const res = entry.reply.raw as import("http").ServerResponse;
            if (chunk) res.write(Buffer.from(chunk));
          } catch (e) {
            req.log.error({ e }, "Failed to write response chunk");
          }
          break;
        }
        case FrameType.END: {
          const info = assignedSubdomain
            ? tunnels.get(assignedSubdomain)
            : undefined;
          if (!info) break;
          const { streamId, phase } = msg as any;
          const entry = info.streams.get(streamId);
          if (!entry) break;
          if (phase === "res") {
            clearTimeout(entry.timeout);
            info.streams.delete(streamId);
            try {
              const res = entry.reply.raw as import("http").ServerResponse;
              res.end();
            } catch (e) {
              req.log.error({ e }, "Failed to end response");
            }
          }
          break;
        }
        default: {
          // Other frames (OPEN_STREAM, etc.) will be handled later when wiring proxying
          break;
        }
      }
    } catch (err) {
      req.log.error({ err }, "Failed to decode WS frame");
    }
  });

  socket.on("close", () => {
    if (assignedSubdomain) {
      tunnels.delete(assignedSubdomain);
      app.log.info({ sub: assignedSubdomain }, "Tunnel closed");
    }
  });
});

// Public traffic handler: route by Host header and stream via client tunnel
app.all("/*", async (req, reply) => {
  const rawHost = (req.headers.host || "").toLowerCase();
  const host = rawHost.includes(":") ? rawHost.split(":")[0] : rawHost;
  const sub = extractSubdomain(host, DOMAIN_BASE);
  if (!sub) {
    return reply.code(404).send({ error: "Not Found" });
  }
  const info = tunnels.get(sub);
  if (!info) {
    return reply.code(502).send({ error: "Tunnel not connected" });
  }
  const streamId = info.nextStreamId++;
  const urlPath = req.raw.url || "/";
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v;
  }
  // Track response streaming and timeout
  const timeout = setTimeout(() => {
    info.streams.delete(streamId);
    try {
      reply.code(504).send({ error: "Upstream timeout" });
    } catch {}
  }, 30000);
  info.streams.set(streamId, { reply, timeout, headersSent: false });
  // Switch to manual streaming
  reply.hijack();
  // Ask client to open stream against its local target
  send(info.ws, {
    t: FrameType.OPEN_STREAM,
    tunnelId: info.tunnelId,
    streamId,
    method: req.method,
    path: urlPath,
    headers,
  });
  // Forward request body if any
  if (req.raw.readable && !["GET", "HEAD"].includes(req.method)) {
    for await (const chunk of req.raw as any as AsyncIterable<Buffer>) {
      send(info.ws, {
        t: FrameType.REQ_DATA,
        tunnelId: info.tunnelId,
        streamId,
        chunk,
      } as any);
    }
  }
  // Signal end of request body
  send(info.ws, {
    t: FrameType.END,
    tunnelId: info.tunnelId,
    streamId,
    phase: "req",
  } as any);
  return;
});

function send(ws: WebSocket, frame: any) {
  ws.send(packr.pack(frame));
}

function generateRandomSubdomain() {
  return Math.random().toString(36).slice(2, 9);
}

function extractSubdomain(host: string, base: string): string | null {
  // matches <sub>.<base>
  if (!host.endsWith(base)) return null;
  const suffix = host.slice(0, -base.length);
  if (!suffix.endsWith(".")) return null;
  const sub = suffix.slice(0, -1);
  if (!isValidSubdomain(sub)) return null;
  return sub;
}

function normalizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (["transfer-encoding", "connection", "keep-alive"].includes(lk))
      continue;
    out[k] = v;
  }
  return out;
}

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() =>
    app.log.info(`Server listening on :${PORT}, domain base ${DOMAIN_BASE}`)
  )
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
