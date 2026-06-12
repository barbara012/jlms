import { api } from "./api";

export type TrafficSample = { up: number; down: number };

export type ConnectionMetadata = {
  network?: string;
  type?: string;
  sourceIP?: string;
  destinationIP?: string;
  sourcePort?: string;
  destinationPort?: string;
  host?: string;
  dnsMode?: string;
  process?: string;
  processPath?: string;
  specialProxy?: string;
  remoteDestination?: string;
  sniffHost?: string;
};

export type ConnectionItem = {
  id?: string;
  upload?: number;
  download?: number;
  start?: string;
  chains?: string[];
  rule?: string;
  rulePayload?: string;
  metadata?: ConnectionMetadata;
};

export type ConnectionsSnapshot = {
  downloadTotal: number;
  uploadTotal: number;
  connections: ConnectionItem[] | null;
};

type StreamOptions = {
  throttleMs?: number;
};

/**
 * Open a mihomo controller WebSocket stream (`/traffic`, `/connections`,
 * `/memory`, `/logs`). Returns a function that closes it. Auto-reconnects
 * once on unexpected close while still mounted.
 */
export async function openStream<T>(
  path: string,
  onMessage: (data: T) => void,
  options?: StreamOptions,
): Promise<() => void> {
  let closed = false;
  let ws: WebSocket | null = null;
  let flushTimer: number | null = null;
  let reconnectTimer: number | null = null;
  let latestFrame: string | null = null;
  let connectAttempt = 0;

  const parseAndEmit = (frame: string) => {
    try {
      onMessage(JSON.parse(frame) as T);
    } catch {
      /* ignore malformed frames */
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const emit = (frame: string) => {
    const throttleMs = options?.throttleMs ?? 0;
    if (throttleMs <= 0) {
      parseAndEmit(frame);
      return;
    }

    latestFrame = frame;
    if (flushTimer !== null) return;

    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      if (latestFrame !== null) {
        parseAndEmit(latestFrame);
        latestFrame = null;
      }
    }, throttleMs);
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 1500);
  };

  const connect = async () => {
    const attempt = ++connectAttempt;

    try {
      const info = await api.controllerInfo();
      if (closed || attempt !== connectAttempt) return;

      const url = `ws://${info.controller}/${path}?token=${encodeURIComponent(info.secret)}`;
      const socket = new WebSocket(url);
      ws = socket;

      socket.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        emit(ev.data);
      };
      socket.onerror = () => {
        socket.close();
      };
      socket.onclose = () => {
        if (ws === socket) {
          ws = null;
        }
        scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  };

  await connect().catch(() => {
    /* core may not be up yet; the caller can retry */
  });

  return () => {
    closed = true;
    clearReconnectTimer();
    if (flushTimer !== null) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    latestFrame = null;
    ws?.close();
  };
}
