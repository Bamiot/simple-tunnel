export const PROTOCOL_VERSION = 1 as const;

export enum FrameType {
  HELLO = 1,
  REGISTER_TUNNEL = 2,
  REGISTERED = 3,
  OPEN_STREAM = 4,
  DATA = 5,
  END = 6,
  ERROR = 7,
  PING = 8,
  PONG = 9,
  UNREGISTER_TUNNEL = 10,
  REQ_DATA = 11,
  RESP_START = 12,
  RESP_DATA = 13
}

export type Headers = Record<string, string>;

export interface HelloFrame {
  t: FrameType.HELLO;
  v: number; // protocol version
  token?: string;
}

export interface RegisterTunnelFrame {
  t: FrameType.REGISTER_TUNNEL;
  subdomain?: string;
  // optional hints; actual local target is only known to the client
}

export interface RegisteredFrame {
  t: FrameType.REGISTERED;
  subdomain: string;
  tunnelId: string;
}

export interface OpenStreamFrame {
  t: FrameType.OPEN_STREAM;
  tunnelId: string;
  streamId: number;
  method: string;
  path: string;
  headers: Headers;
}

export interface DataFrame {
  t: FrameType.DATA;
  tunnelId: string;
  streamId: number;
  // Minimal MVP: include an inline chunk to avoid binary frame multiplexing
  chunk?: Uint8Array;
}

export interface EndFrame {
  t: FrameType.END;
  tunnelId: string;
  streamId: number;
  statusCode?: number; // for response finalization
  phase?: 'req' | 'res';
}

export interface ErrorFrame {
  t: FrameType.ERROR;
  code: string;
  message?: string;
}

export interface PingFrame { t: FrameType.PING }
export interface PongFrame { t: FrameType.PONG }

export type ControlFrame =
  | HelloFrame
  | RegisterTunnelFrame
  | RegisteredFrame
  | OpenStreamFrame
  | EndFrame
  | ErrorFrame
  | PingFrame
  | PongFrame;

export interface ReqDataFrame {
  t: FrameType.REQ_DATA;
  tunnelId: string;
  streamId: number;
  chunk: Uint8Array;
}

export interface RespStartFrame {
  t: FrameType.RESP_START;
  tunnelId: string;
  streamId: number;
  statusCode: number;
  headers?: Headers;
}

export interface RespDataFrame {
  t: FrameType.RESP_DATA;
  tunnelId: string;
  streamId: number;
  chunk: Uint8Array;
}

export type AnyFrame = ControlFrame | DataFrame | ReqDataFrame | RespStartFrame | RespDataFrame;

export const SUBDOMAIN_REGEX = /^[a-z0-9-]{3,63}$/;

export function isValidSubdomain(s: string): boolean {
  return SUBDOMAIN_REGEX.test(s);
}
