import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  type CoreStatus,
  type LatencyDiagnostics,
  type ProfilesIndex,
  type ProxiesResponse,
  type ProxyNode,
  type SystemProxyStatus,
} from "./api";
import {
  openStream,
  type TrafficSample,
  type ConnectionsSnapshot,
  type ConnectionItem,
} from "./ws";

function fmt(n: number): { v: string; u: string } {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const value = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return { v: value, u: units[i] };
}

const MODE_LABEL: Record<string, string> = {
  rule: "规则",
  global: "全局",
  direct: "直连",
};

const OVERVIEW_TRAFFIC_THROTTLE_MS = 160;
const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 64;
const SPARK_POINTS = 24;
const SPARK_SCROLL_STEP_MS = 120;

const TRAFFIC_LEDGER_KEY = "jlms-overview-traffic-ledger:v1";

type TrafficBucket = {
  total: number;
  direct: number;
  proxy: number;
};

type TrafficLedger = {
  dayKey: string;
  monthKey: string;
  today: TrafficBucket;
  month: TrafficBucket;
};

type TrafficBarSample = {
  all: number;
  proxy: number;
};

type TrafficViewMode = "all" | "proxy";
type TrafficContentTab = "client" | "domain" | "policy";
type TotalTrafficRange = "today" | "month";

type TrafficRow = {
  title: string;
  subtitle: string;
  total: number;
  count: number;
};

type ProxySelectionChangedPayload = {
  group: string;
  name: string;
};

function emptyTrafficBucket(): TrafficBucket {
  return { total: 0, direct: 0, proxy: 0 };
}

function currentTrafficKeys(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return {
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
  };
}

function createTrafficLedger(date = new Date()): TrafficLedger {
  const { dayKey, monthKey } = currentTrafficKeys(date);
  return {
    dayKey,
    monthKey,
    today: emptyTrafficBucket(),
    month: emptyTrafficBucket(),
  };
}

function normalizeTrafficBucket(value: unknown): TrafficBucket {
  const item = typeof value === "object" && value ? (value as Partial<TrafficBucket>) : {};
  return {
    total: typeof item.total === "number" && Number.isFinite(item.total) ? item.total : 0,
    direct: typeof item.direct === "number" && Number.isFinite(item.direct) ? item.direct : 0,
    proxy: typeof item.proxy === "number" && Number.isFinite(item.proxy) ? item.proxy : 0,
  };
}

function rollTrafficLedger(value: unknown, date = new Date()): TrafficLedger {
  const raw = typeof value === "object" && value ? (value as Partial<TrafficLedger>) : {};
  const keys = currentTrafficKeys(date);
  const monthChanged = raw.monthKey !== keys.monthKey;
  const dayChanged = raw.dayKey !== keys.dayKey;
  return {
    dayKey: keys.dayKey,
    monthKey: keys.monthKey,
    today: dayChanged || monthChanged ? emptyTrafficBucket() : normalizeTrafficBucket(raw.today),
    month: monthChanged ? emptyTrafficBucket() : normalizeTrafficBucket(raw.month),
  };
}

function addTrafficDelta(ledger: TrafficLedger, delta: TrafficBucket): TrafficLedger {
  const next = rollTrafficLedger(ledger);
  return {
    ...next,
    today: {
      total: next.today.total + delta.total,
      direct: next.today.direct + delta.direct,
      proxy: next.today.proxy + delta.proxy,
    },
    month: {
      total: next.month.total + delta.total,
      direct: next.month.direct + delta.direct,
      proxy: next.month.proxy + delta.proxy,
    },
  };
}

function loadTrafficLedger(): TrafficLedger {
  if (typeof window === "undefined") return createTrafficLedger();
  try {
    const raw = window.localStorage.getItem(TRAFFIC_LEDGER_KEY);
    if (!raw) return createTrafficLedger();
    return rollTrafficLedger(JSON.parse(raw));
  } catch {
    return createTrafficLedger();
  }
}

function saveTrafficLedger(ledger: TrafficLedger) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TRAFFIC_LEDGER_KEY, JSON.stringify(ledger));
}

function latestDelay(node: ProxyNode): number | undefined {
  const history = node.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const value = history[i]?.delay;
    if (typeof value === "number" && value > 0) return value;
  }
  return undefined;
}

function isPolicyGroupNode(node: ProxyNode | undefined): boolean {
  return Array.isArray(node?.all) && node.all.length > 0;
}

function resolveProxyChain(
  proxiesMap: Record<string, ProxyNode>,
  startName: string,
): { chain: string[]; name: string; delay: number | undefined } {
  const visited = new Set<string>();
  const chain = [startName];
  let currentName = startName;
  let currentNode = proxiesMap[currentName];

  while (currentNode && isPolicyGroupNode(currentNode) && currentNode.now) {
    if (visited.has(currentName)) break;
    visited.add(currentName);

    const nextName = currentNode.now.trim();
    if (!nextName || nextName === currentName) break;

    const nextNode = proxiesMap[nextName];
    currentName = nextName;
    chain.push(nextName);
    if (!nextNode) {
      return {
        chain,
        name: nextName,
        delay: latestDelay(currentNode),
      };
    }
    currentNode = nextNode;
  }

  return {
    chain,
    name: currentNode?.name ?? currentName,
    delay: currentNode ? latestDelay(currentNode) : undefined,
  };
}

function resolveDefaultOutbound(proxies: ProxiesResponse | null, status: CoreStatus | null) {
  const groupName = status?.default_group?.trim();
  if (!groupName) {
    return { group: "", chain: [] as string[], node: "未测节点", delay: undefined as number | undefined };
  }

  const proxiesMap = proxies?.proxies ?? {};
  const group = proxiesMap[groupName];
  if (!group) {
    return { group: groupName, chain: [groupName], node: groupName, delay: undefined as number | undefined };
  }

  const leaf = resolveProxyChain(proxiesMap, groupName);

  return {
    group: groupName,
    chain: leaf.chain,
    node: leaf.name,
    delay: leaf.delay,
  };
}

function formatMeasuredAt(timestamp: number | null) {
  if (!timestamp) return "未测量";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function padSeries(values: number[], size: number) {
  const normalized = values.slice(-size);
  if (normalized.length >= size) return normalized;
  return [...Array.from({ length: size - normalized.length }, () => 0), ...normalized];
}

function scrollingSparklinePath(values: number[], width: number, height: number, progress: number) {
  if (values.length === 0) return "";
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? width / (SPARK_POINTS - 1) : 0;
  return values
    .map((value, index) => {
      const x = index * stepX - progress * stepX;
      const y = height - (value / max) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function hostOf(conn: ConnectionItem) {
  const meta = conn.metadata;
  return meta?.host || meta?.sniffHost || meta?.remoteDestination || meta?.destinationIP || "—";
}

function chainOf(conn: ConnectionItem) {
  if (conn.chains && conn.chains.length > 0) return conn.chains.join(" / ");
  return conn.metadata?.specialProxy || "DIRECT";
}

function processOf(conn: ConnectionItem) {
  return conn.metadata?.process || conn.metadata?.processPath || "未知进程";
}

function formatNetworkLabel(proxy: SystemProxyStatus | null) {
  const raw =
    proxy?.primary_hardware_port ??
    proxy?.primary_service ??
    proxy?.services[0] ??
    (proxy?.enabled ? "系统代理" : "当前服务");
  const normalized = raw.trim().toLowerCase();

  if (
    normalized.includes("wi-fi") ||
    normalized.includes("wifi") ||
    normalized.includes("wlan") ||
    normalized.includes("airport")
  ) {
    return "无线网络";
  }

  if (
    normalized.includes("ethernet") ||
    normalized.includes("thunderbolt") ||
    normalized.includes("lan")
  ) {
    return "有线网络";
  }

  if (normalized.includes("cdc device")) {
    return "无线网络";
  }

  return raw;
}

function normalizeSystemProxyError(error: string) {
  if (
    error.includes("system proxy is only supported on macOS") ||
    error.includes("not implemented on this platform yet")
  ) {
    return "当前版本尚未实现此平台的系统代理控制。";
  }
  return error;
}

function totalOf(conn: ConnectionItem) {
  return (conn.download ?? 0) + (conn.upload ?? 0);
}

function applyProxySelection(
  prev: ProxiesResponse | null,
  payload: ProxySelectionChangedPayload,
): ProxiesResponse | null {
  if (!prev?.proxies || !payload.group || !payload.name) return prev;
  const target = prev.proxies[payload.group];
  if (!target || target.now === payload.name) return prev;
  return {
    ...prev,
    proxies: {
      ...prev.proxies,
      [payload.group]: {
        ...target,
        now: payload.name,
      },
    },
  };
}

function connectionKey(conn: ConnectionItem, index: number) {
  return (
    conn.id ??
    [
      conn.start ?? "",
      conn.metadata?.sourceIP ?? "",
      conn.metadata?.sourcePort ?? "",
      conn.metadata?.destinationIP ?? "",
      conn.metadata?.destinationPort ?? "",
      hostOf(conn),
      index,
    ].join("|")
  );
}

function deriveConnectionStats(
  connections: ConnectionItem[],
  trafficViewMode: TrafficViewMode,
  trafficContentTab: TrafficContentTab,
) {
  const processSet = new Set<string>();
  const deviceSet = new Set<string>();
  const policySet = new Set<string>();
  const groups = new Map<string, TrafficRow>();
  let direct = 0;
  let proxy = 0;

  for (const item of connections) {
    const process = processOf(item);
    const device = item.metadata?.sourceIP;
    const policy = chainOf(item);
    const host = hostOf(item);
    const amount = totalOf(item);
    const viaProxy = policy !== "DIRECT";

    if (process && process !== "未知进程") processSet.add(process);
    if (device) deviceSet.add(device);
    if (policy) policySet.add(policy);

    if (viaProxy) proxy += amount;
    else direct += amount;

    if (trafficViewMode === "proxy" && !viaProxy) {
      continue;
    }

    let key = "";
    let title = "";
    let subtitle = "";

    if (trafficContentTab === "client") {
      key = process === "未知进程" ? `host:${host}` : `process:${process}`;
      title = process === "未知进程" ? host : process;
      subtitle = process === "未知进程" ? policy : host;
    } else if (trafficContentTab === "domain") {
      key = host;
      title = host;
      subtitle = policy;
    } else {
      key = policy;
      title = policy;
      subtitle = "连接";
    }

    const current = groups.get(key) ?? { title, subtitle, total: 0, count: 0 };
    current.total += amount;
    current.count += 1;
    groups.set(key, current);
  }

  const overall = direct + proxy;
  const trafficRows = [...groups.values()]
    .map((item) => ({
      ...item,
      subtitle: trafficContentTab === "policy" ? `${item.count} 个连接` : item.subtitle,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  return {
    uniqueProcesses: processSet.size,
    uniqueDevices: deviceSet.size,
    uniquePolicies: policySet.size,
    trafficSplit: {
      direct,
      proxy,
      overall,
      directWidth: overall > 0 ? `${(direct / overall) * 100}%` : "50%",
      proxyWidth: overall > 0 ? `${(proxy / overall) * 100}%` : "50%",
    },
    trafficRows,
  };
}

export function Overview({ status }: { status: CoreStatus | null }) {
  const [traffic, setTraffic] = useState<TrafficSample>({ up: 0, down: 0 });
  const [trafficHistory, setTrafficHistory] = useState<TrafficSample[]>([]);
  const [conn, setConn] = useState<ConnectionsSnapshot | null>(null);
  const [proxy, setProxy] = useState<SystemProxyStatus | null>(null);
  const [latencyDiagnostics, setLatencyDiagnostics] = useState<LatencyDiagnostics | null>(null);
  const [proxies, setProxies] = useState<ProxiesResponse | null>(null);
  const [profiles, setProfiles] = useState<ProfilesIndex | null>(null);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyPendingEnabled, setProxyPendingEnabled] = useState<boolean | null>(null);
  const [latencyBusy, setLatencyBusy] = useState(false);
  const [latencyPanelOpen, setLatencyPanelOpen] = useState(false);
  const [lastLatencyMeasuredAt, setLastLatencyMeasuredAt] = useState<number | null>(null);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [totalRange, setTotalRange] = useState<TotalTrafficRange>("today");
  const [trafficViewMode, setTrafficViewMode] = useState<TrafficViewMode>("all");
  const [trafficContentTab, setTrafficContentTab] = useState<TrafficContentTab>("client");
  const [trafficLedger, setTrafficLedger] = useState<TrafficLedger>(() => loadTrafficLedger());
  const [trafficBars, setTrafficBars] = useState<TrafficBarSample[]>([]);
  const previousConnectionTotalsRef = useRef<Map<string, { total: number; viaProxy: boolean }> | null>(null);
  const ledgerSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let stopT = () => {};
    let stopC = () => {};
    openStream<TrafficSample>("traffic", setTraffic, { throttleMs: OVERVIEW_TRAFFIC_THROTTLE_MS }).then(
      (f) => (stopT = f),
    );
    openStream<ConnectionsSnapshot>("connections", setConn, { throttleMs: 400 }).then((f) => (stopC = f));
    return () => {
      stopT();
      stopC();
    };
  }, []);

  useEffect(() => {
    setTrafficHistory((prev) => {
      if (
        prev.length > 0 &&
        prev[prev.length - 1]?.up === traffic.up &&
        prev[prev.length - 1]?.down === traffic.down
      ) {
        return prev;
      }
      return [...prev, traffic].slice(-24);
    });
  }, [traffic]);

  useEffect(() => {
    const connections = conn?.connections ?? [];
    const current = new Map<string, { total: number; viaProxy: boolean }>();
    connections.forEach((item, index) => {
      current.set(connectionKey(item, index), {
        total: totalOf(item),
        viaProxy: chainOf(item) !== "DIRECT",
      });
    });

    const previous = previousConnectionTotalsRef.current;
    previousConnectionTotalsRef.current = current;

    if (!previous) {
      setTrafficLedger((prev) => rollTrafficLedger(prev));
      return;
    }

    let direct = 0;
    let proxyAmount = 0;
    current.forEach((item, key) => {
      const delta = Math.max(0, item.total - (previous.get(key)?.total ?? 0));
      if (delta <= 0) return;
      if (item.viaProxy) proxyAmount += delta;
      else direct += delta;
    });

    const delta = {
      total: direct + proxyAmount,
      direct,
      proxy: proxyAmount,
    };

    setTrafficBars((prev) => [...prev, { all: delta.total, proxy: delta.proxy }].slice(-24));
    setTrafficLedger((prev) => (delta.total > 0 ? addTrafficDelta(prev, delta) : rollTrafficLedger(prev)));
  }, [conn]);

  useEffect(() => {
    if (ledgerSaveTimerRef.current !== null) {
      window.clearTimeout(ledgerSaveTimerRef.current);
    }
    ledgerSaveTimerRef.current = window.setTimeout(() => {
      saveTrafficLedger(trafficLedger);
      ledgerSaveTimerRef.current = null;
    }, 250);
    return () => {
      if (ledgerSaveTimerRef.current !== null) {
        window.clearTimeout(ledgerSaveTimerRef.current);
        ledgerSaveTimerRef.current = null;
      }
    };
  }, [trafficLedger]);

  const loadSystemProxy = useCallback(async () => {
    try {
      setProxy(await api.systemProxyStatus());
      setProxyPendingEnabled(null);
    } catch (e) {
      setProxyError(normalizeSystemProxyError(String(e)));
    }
  }, []);

  useEffect(() => {
    setProxyError(null);
    void loadSystemProxy();
  }, [loadSystemProxy, status?.mixed_port]);

  useEffect(() => {
    api.profilesList()
      .then(setProfiles)
      .catch(() => {
        /* ignore */
      });
  }, []);

  const loadLatencyDiagnostics = useCallback(async (silent = false) => {
    if (!silent) setLatencyBusy(true);
    try {
      setLatencyDiagnostics(await api.latencyDiagnostics());
      setLastLatencyMeasuredAt(Date.now());
    } catch {
      if (!silent) {
        setLatencyDiagnostics(null);
      }
    } finally {
      if (!silent) setLatencyBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadLatencyDiagnostics(true);
  }, [loadLatencyDiagnostics, proxy?.primary_service, proxy?.primary_hardware_port]);

  const loadPolicies = useCallback(async () => {
    if (!status?.running) {
      setProxies(null);
      return;
    }
    try {
      setProxies(await api.proxiesGet());
    } catch {
      setProxies(null);
    }
  }, [status?.running]);

  useEffect(() => {
    void loadPolicies();
  }, [loadPolicies]);

  useEffect(() => {
    const proxyPromise = listen<SystemProxyStatus>("system-proxy://changed", (event) => {
      setProxy(event.payload);
      setProxyPendingEnabled(null);
      setProxyError(null);
    });
    const selectionPromise = listen<ProxySelectionChangedPayload>("proxy://selection-changed", (event) => {
      const payload = event.payload;
      if (!payload) return;
      setProxies((prev) => applyProxySelection(prev, payload));
    });

    return () => {
      void proxyPromise.then((off) => off());
      void selectionPromise.then((off) => off());
    };
  }, [loadPolicies]);

  const toggleSystemProxy = async () => {
    if (proxyBusy) return;
    const previousProxy = proxy;
    const nextEnabled = !(previousProxy?.enabled ?? false);
    setProxyBusy(true);
    setProxyPendingEnabled(nextEnabled);
    setProxyError(null);
    setProxy((prev) =>
      prev
        ? {
            ...prev,
            enabled: nextEnabled,
          }
        : {
            enabled: nextEnabled,
            host: "127.0.0.1",
            port: status?.mixed_port ?? 0,
            services: [],
            primary_service: null,
            primary_hardware_port: null,
          },
    );
    try {
      const next = await api.systemProxySet(nextEnabled);
      setProxy(next);
      setProxyPendingEnabled(null);
    } catch (e) {
      setProxy(previousProxy);
      setProxyPendingEnabled(null);
      setProxyError(normalizeSystemProxyError(String(e)));
    } finally {
      setProxyBusy(false);
    }
  };

  const down = fmt(traffic.down);
  const up = fmt(traffic.up);
  const connections = conn?.connections ?? [];
  const connCount = connections.length;
  const activeProfile = profiles?.profiles.find((item) => item.id === profiles.active) ?? null;
  const defaultOutbound = useMemo(() => resolveDefaultOutbound(proxies, status), [proxies, status]);
  const derivedConnections = useMemo(
    () => deriveConnectionStats(connections, trafficViewMode, trafficContentTab),
    [connections, trafficContentTab, trafficViewMode],
  );
  const {
    uniqueProcesses,
    uniqueDevices,
    uniquePolicies,
    trafficSplit,
    trafficRows,
  } = derivedConnections;
  const uploadSeries = useMemo(() => trafficHistory.map((item) => item.up), [trafficHistory]);
  const downloadSeries = useMemo(() => trafficHistory.map((item) => item.down), [trafficHistory]);
  const uploadPeak = fmt(Math.max(0, ...uploadSeries));
  const downloadPeak = fmt(Math.max(0, ...downloadSeries));
  const selectedTrafficBucket = useMemo(() => {
    const selected = totalRange === "today" ? trafficLedger.today : trafficLedger.month;
    if (selected.total > 0) return selected;
    return {
      total: (conn?.downloadTotal ?? 0) + (conn?.uploadTotal ?? 0),
      direct: trafficSplit.direct,
      proxy: trafficSplit.proxy,
    };
  }, [conn, totalRange, trafficLedger, trafficSplit.direct, trafficSplit.proxy]);
  const selectedTrafficSplit = useMemo(() => {
    const overall = selectedTrafficBucket.direct + selectedTrafficBucket.proxy;
    return {
      overall,
      directWidth: overall > 0 ? `${(selectedTrafficBucket.direct / overall) * 100}%` : "50%",
      proxyWidth: overall > 0 ? `${(selectedTrafficBucket.proxy / overall) * 100}%` : "50%",
    };
  }, [selectedTrafficBucket]);
  const total = fmt(selectedTrafficBucket.total);
  const directTotal = fmt(selectedTrafficBucket.direct);
  const proxyTotal = fmt(selectedTrafficBucket.proxy);
  const barValues = useMemo(() => {
    if (trafficViewMode === "proxy") {
      const proxyValues = trafficBars.map((item) => item.proxy);
      if (proxyValues.some((value) => value > 0)) return proxyValues;
    }
    return trafficHistory.map((item) => Math.max(item.down, item.up));
  }, [trafficBars, trafficHistory, trafficViewMode]);
  const maxBarValue = useMemo(() => Math.max(1, ...barValues), [barValues]);
  const profileName = activeProfile?.name ?? "未启用";
  const serviceName = formatNetworkLabel(proxy);
  const displayedProxyEnabled = proxyPendingEnabled ?? (proxy?.enabled ?? false);
  const systemProxyHint =
    proxyPendingEnabled !== null
      ? proxyPendingEnabled
        ? "正在开启系统代理…"
        : "正在关闭系统代理…"
      : proxy?.enabled
        ? `${proxy.host}:${proxy.port}${proxy.services.length ? ` · ${proxy.services.length} 个服务` : ""}`
        : "关闭";
  const defaultOutboundChain =
    defaultOutbound.chain.length > 0 ? defaultOutbound.chain.join(" -> ") : defaultOutbound.node;
  const routerLatency =
    latencyDiagnostics?.router_ms !== undefined && latencyDiagnostics?.router_ms !== null
      ? `${latencyDiagnostics.router_ms} ms`
      : "—";
  const dnsLatency =
    latencyDiagnostics?.dns_ms !== undefined && latencyDiagnostics?.dns_ms !== null
      ? `${latencyDiagnostics.dns_ms} ms`
      : "—";
  const headerFacts = [
    { label: "网络", value: serviceName },
    { label: "Profile", value: profileName },
    { label: "出站模式", value: MODE_LABEL[status?.mode ?? ""] ?? "规则" },
    { label: "Controller", value: status?.controller ?? "127.0.0.1:9090" },
  ];

  return (
    <div className="view overview-view">
      <section className="activity-head">
        <div>
          <div className="activity-kicker">概览</div>
          <h1 className="activity-title">概览</h1>
        </div>
      </section>

      <div className="activity-facts">
        {headerFacts.map((item) => (
          <div key={item.label} className="activity-fact">
            <div className="activity-fact-label">{item.label}</div>
            <div className="activity-fact-value">{item.value}</div>
          </div>
        ))}
      </div>

      <div className="overview-shell">
        <div className="overview-column left">
          <section className="surge-card surge-latency-card">
            <div className="surge-card-head">
              <div>
                <div className="surge-card-label">网络延迟</div>
                <div className="surge-latency-value">
                  {defaultOutbound.delay ?? 0}
                  <small>ms</small>
                </div>
              </div>
              <div className="surge-latency-actions">
                <button className="sm ghost" disabled={latencyBusy} onClick={() => void loadLatencyDiagnostics()}>
                  {latencyBusy ? "诊断中…" : "诊断"}
                </button>
                <button className="sm ghost" disabled={latencyBusy} onClick={() => setLatencyPanelOpen(true)}>
                  详情
                </button>
              </div>
            </div>
            <div className="surge-latency-footer">
              <div className="surge-latency-meta">
                <span className="mini-label">网关</span>
                <b>{routerLatency}</b>
              </div>
              <div className="surge-latency-meta">
                <span className="mini-label">DNS</span>
                <b>{dnsLatency}</b>
              </div>
              <div className="surge-latency-meta current">
                <span className="surge-latency-node">{defaultOutbound.node}</span>
                <b>{defaultOutbound.delay !== undefined ? `${defaultOutbound.delay} ms` : "未测"}</b>
              </div>
            </div>
          </section>

          <section className="surge-card surge-connection-card">
            <div className="surge-card-head">
              <div className="surge-card-label">活动连接</div>
              <span className="surge-dot" />
            </div>
            <div className="surge-connection-value">{connCount}</div>
            <div className="surge-mini-stats triple">
              <div className="surge-mini-stat">
                <span className="mini-label">进程</span>
                <b>{uniqueProcesses}</b>
              </div>
              <div className="surge-mini-stat">
                <span className="mini-label">设备</span>
                <b>{uniqueDevices}</b>
              </div>
              <div className="surge-mini-stat">
                <span className="mini-label">Policy</span>
                <b>{uniquePolicies}</b>
              </div>
            </div>
          </section>

          <section className="surge-card surge-total-card">
            <div className="surge-card-head">
              <div className="surge-card-label">Traffic</div>
              <div className="segmented mini">
                <button className={totalRange === "today" ? "active" : ""} onClick={() => setTotalRange("today")}>
                  今日
                </button>
                <button className={totalRange === "month" ? "active" : ""} onClick={() => setTotalRange("month")}>
                  本月
                </button>
              </div>
            </div>
            <div className="surge-total-value">
              {total.v}
              <small>{total.u}</small>
            </div>
            <div className="surge-total-meta">
              <div className="surge-total-side">
                <span className="mini-label">直连</span>
                <b>
                  {directTotal.v}
                  <small>{directTotal.u}</small>
                </b>
              </div>
              <div className="surge-total-side right">
                <span className="mini-label">代理</span>
                <b>
                  {proxyTotal.v}
                  <small>{proxyTotal.u}</small>
                </b>
              </div>
            </div>
            <div className="surge-traffic-breakdown">
              <div className="traffic-breakdown-bar">
                <span className="direct" style={{ width: selectedTrafficSplit.directWidth }} />
                <span className="proxy" style={{ width: selectedTrafficSplit.proxyWidth }} />
              </div>
            </div>
          </section>
        </div>

        <div className="overview-column right">
          <div className="overview-speed-row">
            <section className="surge-card surge-speed-card upload">
              <div className="surge-speed-head">
                <div className="surge-card-label">上传</div>
                <span className="surge-speed-scale">
                  {uploadPeak.v} {uploadPeak.u}/s
                </span>
              </div>
              <div className="surge-speed-value">
                {up.v}
                <small>{up.u}/s</small>
              </div>
              <div className="surge-speed-hint">实时上传速率</div>
              <SmoothSparkline seedValues={uploadSeries} liveValue={traffic.up} tone="upload" />
            </section>

            <section className="surge-card surge-speed-card download">
              <div className="surge-speed-head">
                <div className="surge-card-label">下载</div>
                <span className="surge-speed-scale">
                  {downloadPeak.v} {downloadPeak.u}/s
                </span>
              </div>
              <div className="surge-speed-value">
                {down.v}
                <small>{down.u}/s</small>
              </div>
              <div className="surge-speed-hint">实时下载速率</div>
              <SmoothSparkline seedValues={downloadSeries} liveValue={traffic.down} tone="download" />
            </section>
          </div>

          <section className="surge-card surge-traffic-card">
            <div className="surge-card-head">
              <div className="surge-card-label">Traffic</div>
              <div className="segmented mini">
                <button className={trafficViewMode === "all" ? "active" : ""} onClick={() => setTrafficViewMode("all")}>
                  全部
                </button>
                <button
                  className={trafficViewMode === "proxy" ? "active" : ""}
                  onClick={() => setTrafficViewMode("proxy")}
                >
                  代理
                </button>
              </div>
            </div>
            <div className="surge-bars">
              {barValues.map((value, index) => {
                const height = `${Math.max(10, (value / maxBarValue) * 100)}%`;
                return <span key={`${trafficViewMode}-${value}-${index}`} style={{ height }} />;
              })}
            </div>
            <div className="surge-traffic-content">
              <div className="segmented mini surge-content-tabs">
                <button
                  className={trafficContentTab === "client" ? "active" : ""}
                  onClick={() => setTrafficContentTab("client")}
                >
                  客户端
                </button>
                <button
                  className={trafficContentTab === "domain" ? "active" : ""}
                  onClick={() => setTrafficContentTab("domain")}
                >
                  Domain
                </button>
                <button
                  className={trafficContentTab === "policy" ? "active" : ""}
                  onClick={() => setTrafficContentTab("policy")}
                >
                  Policy
                </button>
              </div>
              {trafficRows.length === 0 ? (
                <div className="empty compact">暂无活动请求。产生流量后这里会展示最近活跃的连接。</div>
              ) : (
                <div className="surge-request-list surge-request-list-compact">
                  {trafficRows.map((item, index) => {
                    const transfer = fmt(item.total);
                    return (
                      <div key={`${trafficContentTab}-${item.title}-${index}`} className="surge-request-row">
                        <div className="surge-request-main">
                          <div className="surge-request-host">{item.title}</div>
                          <div className="surge-request-meta">
                            <span>{item.subtitle}</span>
                          </div>
                        </div>
                        <div className="surge-request-total">
                          {transfer.v}
                          <small>{transfer.u}</small>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="section-title">系统</div>
      {proxyError && <div className="banner error">⚠ {proxyError}</div>}
      <div className="toggles">
        <ToggleItem
          label="系统代理"
          hint={systemProxyHint}
          checked={displayedProxyEnabled}
          disabled={proxyBusy}
          pending={proxyPendingEnabled !== null}
          onToggle={() => void toggleSystemProxy()}
        />
        <ToggleStub label="增强模式" hint="TUN / 接管更多系统流量" />
        <ToggleStub label="MitM" hint="证书注入与抓包将在 v1 后接入" />
      </div>

      {latencyPanelOpen && (
        <div className="latency-panel-backdrop" onClick={() => setLatencyPanelOpen(false)}>
          <section className="latency-panel" onClick={(e) => e.stopPropagation()}>
            <div className="latency-panel-head">
              <div>
                <div className="latency-panel-kicker">诊断</div>
                <h3>网络延迟</h3>
              </div>
              <button className="sm ghost" onClick={() => setLatencyPanelOpen(false)}>
                关闭
              </button>
            </div>
            <div className="latency-panel-grid">
              <div className="latency-panel-item">
                <span>网关</span>
                <b>{routerLatency}</b>
                <small>{latencyDiagnostics?.gateway ?? "未识别默认网关"}</small>
              </div>
              <div className="latency-panel-item">
                <span>DNS</span>
                <b>{dnsLatency}</b>
                <small>{latencyDiagnostics?.dns_server ?? "未识别 DNS 服务器"}</small>
              </div>
              <div className="latency-panel-item wide">
                <span>Outbound Chain</span>
                <b>{defaultOutbound.node}</b>
                <small>{defaultOutboundChain}</small>
              </div>
              <div className="latency-panel-item wide">
                <span>最近测量</span>
                <b>{formatMeasuredAt(lastLatencyMeasuredAt)}</b>
                <small>{latencyDiagnostics?.primary_service ?? serviceName}</small>
              </div>
            </div>
            <div className="latency-panel-actions">
              <button
                className="sm primary"
                disabled={latencyBusy}
                onClick={() => void loadLatencyDiagnostics()}
              >
                {latencyBusy ? "诊断中…" : "重新测量"}
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function SmoothSparkline({
  seedValues,
  liveValue,
  tone,
}: {
  seedValues: number[];
  liveValue: number;
  tone: "upload" | "download";
}) {
  const pathRef = useRef<SVGPathElement | null>(null);
  const initialSeries = useMemo(() => padSeries(seedValues, SPARK_POINTS), [seedValues]);
  const frameRef = useRef<number | null>(null);
  const seriesRef = useRef<number[]>(initialSeries);
  const latestValueRef = useRef(liveValue);
  const lastCommitRef = useRef<number>(0);
  const initializedRef = useRef(false);
  const drawRef = useRef<(progress?: number) => void>(() => {});

  useEffect(() => {
    latestValueRef.current = liveValue;
  }, [liveValue]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    seriesRef.current = initialSeries;
    const path = scrollingSparklinePath([...initialSeries, latestValueRef.current], SPARK_WIDTH, SPARK_HEIGHT, 0);
    pathRef.current?.setAttribute("d", path);
  }, [initialSeries]);

  useEffect(() => {
    const renderPath = (progress = 0) => {
      const path = scrollingSparklinePath(
        [...seriesRef.current, latestValueRef.current],
        SPARK_WIDTH,
        SPARK_HEIGHT,
        progress,
      );
      pathRef.current?.setAttribute("d", path);
    };
    drawRef.current = renderPath;

    const stop = () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };

    const loop = (now: number) => {
      frameRef.current = null;
      if (!lastCommitRef.current) lastCommitRef.current = now;
      let elapsed = now - lastCommitRef.current;

      if (elapsed > SPARK_SCROLL_STEP_MS * 4) {
        lastCommitRef.current = now - (elapsed % SPARK_SCROLL_STEP_MS);
        elapsed = now - lastCommitRef.current;
      }

      while (elapsed >= SPARK_SCROLL_STEP_MS) {
        seriesRef.current = [...seriesRef.current.slice(1), latestValueRef.current];
        lastCommitRef.current += SPARK_SCROLL_STEP_MS;
        elapsed = now - lastCommitRef.current;
      }

      if (document.visibilityState !== "visible") {
        return;
      }

      renderPath(Math.max(0, Math.min(1, elapsed / SPARK_SCROLL_STEP_MS)));
      frameRef.current = window.requestAnimationFrame(loop);
    };

    const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = () => {
      if (frameRef.current !== null || document.visibilityState !== "visible" || motionMedia.matches) {
        return;
      }
      lastCommitRef.current = 0;
      frameRef.current = window.requestAnimationFrame(loop);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        renderPath(0);
        start();
      } else {
        stop();
      }
    };
    const handleMotionChange = () => {
      renderPath(0);
      if (motionMedia.matches) {
        stop();
      } else {
        start();
      }
    };

    renderPath(0);
    start();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionMedia.addEventListener("change", handleMotionChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionMedia.removeEventListener("change", handleMotionChange);
      stop();
    };
  }, []);

  useEffect(() => {
    if (document.visibilityState !== "visible") {
      drawRef.current(0);
    }
  }, [liveValue]);

  return (
    <div className={`surge-speed-chart ${tone}`}>
      <svg viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        <path ref={pathRef} d="" />
      </svg>
    </div>
  );
}

function ToggleStub({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="toggle disabled">
      <div className="toggle-main">
        <div className="toggle-title">{label}</div>
        <div className="toggle-hint">{hint}</div>
      </div>
      <span className="switch" />
    </div>
  );
}

function ToggleItem({
  label,
  hint,
  checked,
  disabled,
  pending,
  onToggle,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  pending?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-button ${disabled ? "disabled" : ""} ${pending ? "pending" : ""}`}
      onClick={onToggle}
      disabled={disabled}
    >
      <span className="toggle-main">
        <span className="toggle-title">{label}</span>
        <span className="toggle-hint">{disabled ? "应用中…" : hint}</span>
      </span>
      <span className={`switch ${checked ? "on" : ""}`} />
    </button>
  );
}
