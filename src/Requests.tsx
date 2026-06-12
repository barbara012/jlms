import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Search, ArrowDown, ArrowUp } from "lucide-react";
import { openStream, type ConnectionsSnapshot, type ConnectionItem } from "./ws";

function fmtBytes(n: number): { v: string; u: string } {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const value = i === 0 || v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  return { v: value, u: units[i] };
}

function fmtBytesInline(n: number) {
  const { v, u } = fmtBytes(n);
  return `${v} ${u}`;
}

function fmtTime(iso?: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

function hostOf(conn: ConnectionItem) {
  const meta = conn.metadata;
  return meta?.host || meta?.sniffHost || meta?.remoteDestination || meta?.destinationIP || "—";
}

function endpointOf(conn: ConnectionItem) {
  const meta = conn.metadata;
  if (meta?.destinationIP && meta?.destinationPort) {
    return `${meta.destinationIP}:${meta.destinationPort}`;
  }
  if (meta?.destinationIP) return meta.destinationIP;
  return "—";
}

function sourceOf(conn: ConnectionItem) {
  const meta = conn.metadata;
  if (meta?.sourceIP && meta?.sourcePort) {
    return `${meta.sourceIP}:${meta.sourcePort}`;
  }
  if (meta?.sourceIP) return meta.sourceIP;
  return "—";
}

function chainOf(conn: ConnectionItem) {
  if (conn.chains && conn.chains.length > 0) return conn.chains.join(" / ");
  return conn.metadata?.specialProxy || "DIRECT";
}

function processOf(conn: ConnectionItem) {
  return conn.metadata?.process || conn.metadata?.processPath || "未知进程";
}

function totalTrafficOf(conn: ConnectionItem) {
  return (conn.download ?? 0) + (conn.upload ?? 0);
}

function searchTextOf(conn: ConnectionItem) {
  return [
    conn.id,
    conn.rule,
    conn.rulePayload,
    conn.metadata?.host,
    conn.metadata?.destinationIP,
    conn.metadata?.sourceIP,
    conn.metadata?.process,
    conn.metadata?.processPath,
    conn.metadata?.specialProxy,
    ...(conn.chains ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

const REQUEST_ROW_HEIGHT = 124;
const REQUEST_OVERSCAN = 8;

export function Requests() {
  const [snapshot, setSnapshot] = useState<ConnectionsSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);
  const deferredQuery = useDeferredValue(query);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let stop = () => {};
    openStream<ConnectionsSnapshot>("connections", setSnapshot, { throttleMs: 500 }).then((f) => (stop = f));
    return () => {
      stop();
    };
  }, []);

  const connections = snapshot?.connections ?? [];
  const total = (snapshot?.downloadTotal ?? 0) + (snapshot?.uploadTotal ?? 0);

  const rankedConnections = useMemo(() => {
    return connections
      .map((conn) => ({ conn, total: totalTrafficOf(conn) }))
      .sort((a, b) => b.total - a.total);
  }, [connections]);

  const derived = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const filtered: ConnectionItem[] = [];
    const processSet = new Set<string>();
    let directCount = 0;

    for (const item of rankedConnections) {
      const conn = item.conn;
      if (q && !searchTextOf(conn).includes(q)) {
        continue;
      }

      filtered.push(conn);
      const process = processOf(conn);
      if (process !== "未知进程") {
        processSet.add(process);
      }

      const chain = chainOf(conn);
      if (chain === "DIRECT" || chain.includes("DIRECT")) {
        directCount += 1;
      }
    }

    return {
      filtered,
      directCount,
      proxyCount: filtered.length - directCount,
      processCount: processSet.size,
    };
  }, [deferredQuery, rankedConnections]);

  const filtered = derived.filtered;
  const directCount = derived.directCount;
  const proxyCount = derived.proxyCount;
  const processCount = derived.processCount;

  const activeQuery = deferredQuery.trim();
  const isSearchPending = query.trim() !== activeQuery;
  const virtualizationEnabled = filtered.length > 80;

  useEffect(() => {
    const measureHeight = () => {
      const element = listRef.current;
      if (!element) return;
      const top = element.getBoundingClientRect().top;
      setViewportHeight(Math.max(360, window.innerHeight - top - 24));
    };

    measureHeight();
    window.addEventListener("resize", measureHeight);
    return () => window.removeEventListener("resize", measureHeight);
  }, [filtered.length]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    element.scrollTop = 0;
    setScrollTop(0);
  }, [activeQuery]);

  const visibleRange = useMemo(() => {
    if (!virtualizationEnabled) {
      return {
        start: 0,
        end: filtered.length,
        topSpacer: 0,
        bottomSpacer: 0,
      };
    }

    const start = Math.max(0, Math.floor(scrollTop / REQUEST_ROW_HEIGHT) - REQUEST_OVERSCAN);
    const visibleCount = Math.ceil(viewportHeight / REQUEST_ROW_HEIGHT) + REQUEST_OVERSCAN * 2;
    const end = Math.min(filtered.length, start + visibleCount);

    return {
      start,
      end,
      topSpacer: start * REQUEST_ROW_HEIGHT,
      bottomSpacer: Math.max(0, (filtered.length - end) * REQUEST_ROW_HEIGHT),
    };
  }, [filtered.length, scrollTop, viewportHeight, virtualizationEnabled]);

  const renderedConnections = filtered.slice(visibleRange.start, visibleRange.end);

  return (
    <div className="view requests-view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">客户端</div>
          <h1 className="activity-title">进程</h1>
          <p className="page-hero-sub">实时查看当前连接、命中规则、出站链路和进程来源。</p>
        </div>
      </section>

      <div className="metrics metrics-compact">
        <div className="metric">
          <div className="metric-label">活动连接</div>
          <div className="metric-value">{filtered.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">进程数</div>
          <div className="metric-value">{processCount}</div>
        </div>
        <div className="metric">
          <div className="metric-label">代理 / 直连</div>
          <div className="metric-value">{proxyCount} / {directCount}</div>
        </div>
        <div className="metric">
          <div className="metric-label">累计流量</div>
          <div className="metric-value">
            {fmtBytes(total).v}
            <small>{fmtBytes(total).u}</small>
          </div>
        </div>
      </div>

      <div className="requests-toolbar">
        <label className="searchbox">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="搜索域名 / 进程 / 规则 / IP / 节点"
          />
        </label>
        <div className="toolbar-note">
          当前按连接流量排序，显示 {filtered.length} / {connections.length} 条连接。
          {isSearchPending ? " 正在更新搜索结果…" : ""}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty">
          {connections.length === 0 ? "暂无活动连接。产生请求后这里会实时出现。" : "没有匹配当前搜索条件的连接。"}
        </div>
      ) : !virtualizationEnabled ? (
        <div className="request-list surge-request-board">
          {filtered.map((conn, index) => (
            <RequestCard key={conn.id ?? `${hostOf(conn)}-${index}`} conn={conn} />
          ))}
        </div>
      ) : (
        <div
          ref={listRef}
          className="request-virtual-scroll"
          style={{ height: `${viewportHeight}px` }}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          <div className="request-list surge-request-board request-list-window">
            {visibleRange.topSpacer > 0 && <div className="request-spacer" style={{ height: visibleRange.topSpacer }} />}
            {renderedConnections.map((conn, index) => (
              <RequestCard
                key={conn.id ?? `${hostOf(conn)}-${visibleRange.start + index}`}
                conn={conn}
              />
            ))}
            {visibleRange.bottomSpacer > 0 && (
              <div className="request-spacer" style={{ height: visibleRange.bottomSpacer }} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RequestCard({ conn }: { conn: ConnectionItem }) {
  const download = conn.download ?? 0;
  const upload = conn.upload ?? 0;
  const rule = conn.rule || "—";
  const payload = conn.rulePayload || "—";
  const meta = conn.metadata;

  return (
    <section className="request-card request-card-surge">
      <div className="request-top">
        <div className="request-main">
          <div className="request-host">{hostOf(conn)}</div>
          <div className="request-sub">
            <span>{meta?.network || meta?.type || "TCP"}</span>
            <span>{endpointOf(conn)}</span>
            <span>{fmtTime(conn.start)}</span>
          </div>
        </div>
        <div className="request-traffic">
          <span className="request-flow down">
            <ArrowDown size={12} /> {fmtBytesInline(download)}
          </span>
          <span className="request-flow up">
            <ArrowUp size={12} /> {fmtBytesInline(upload)}
          </span>
        </div>
      </div>

      <div className="request-grid">
        <RequestField label="进程" value={processOf(conn)} />
        <RequestField label="来源" value={sourceOf(conn)} mono />
        <RequestField label="规则" value={rule} />
        <RequestField label="规则负载" value={payload} />
        <RequestField label="链路" value={chainOf(conn)} />
        <RequestField label="DNS" value={meta?.dnsMode || "—"} />
      </div>
    </section>
  );
}

function RequestField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="request-field">
      <div className="request-field-label">{label}</div>
      <div className={mono ? "request-field-value mono" : "request-field-value"} title={value}>
        {value}
      </div>
    </div>
  );
}
