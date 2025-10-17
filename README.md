# Simple Tunnel (Skeleton)

Self-hosted reverse tunnel (Ngrok-like) built with Node.js (Fastify), designed to run behind Traefik (Dokploy-ready).

Status: initial skeleton. Server `/connect` registers tunnels; public routing stub returns 501 until proxying is implemented.

## Stack
- Node 20, TypeScript, npm workspaces
- Server: Fastify + `@fastify/websocket`, `pino`
- Client: CLI (`commander`, `ws`, `msgpackr`)
- Protocol: lightweight frames over WebSocket
- Build: `tsup` bundles per package

## Workspace Layout
- `packages/server` – server app (Fastify)
- `packages/cli` – CLI client (simple-tunnel)
- `packages/protocol` – shared protocol types/frames

## Dev Setup
```
npm install
npm run dev:server
```

CLI (skeleton):
```
npm run -w @simple-tunnel/cli dev -- --port 3000 --connect ws://localhost:3000/connect --subdomain app
```

Healthcheck:
```
curl -i http://localhost:3000/health
```

## Build
```
npm run build
```

## Docker
Build locally:
```
docker build -t simple-tunnel:dev .
docker run --rm -p 3000:3000 -e DOMAIN_BASE=localhost simple-tunnel:dev
```

Compose (Traefik labels included): see `docker-compose.yml`.
Set environment variables before deploying:
```
export DOMAIN_BASE=example.com               # apex used for /connect and as subdomain base
export TRAEFIK_CERTRESOLVER=letsencrypt      # matches your Traefik certresolver name
```
Then:
```
docker compose up -d --build
```

## Traefik (overview)
- Public: `https://{sub}.${DOMAIN_BASE}` → server:3000
- Control: `wss://${DOMAIN_BASE}/connect` → server:3000

## Next Steps
- Implement proxy pipeline: OPEN_STREAM/DATA/END, backpressure, error handling
- Client: local HTTP/WS relay via `undici` and binary streaming
- Limits, auth token, metrics endpoint

## Environment Variables
- `DOMAIN_BASE`: Base domain (e.g., `example.com`). Required for routing and URL building.
- `TRAEFIK_CERTRESOLVER`: Traefik certresolver name (default `letsencrypt`).
- CLI (optional):
  - `SIMPLE_TUNNEL_CONNECT`: default control URL (e.g., `wss://example.com/connect`).
  - `SIMPLE_TUNNEL_DOMAIN_BASE`: base domain to format public URL if different from connect host.
