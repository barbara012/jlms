import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown, ChevronRight, ChevronUp, LoaderCircle, RefreshCw, TimerReset } from "lucide-react";
import { api, type ProxiesResponse, type ProxyNode } from "./api";

const POLICY_EXPANDED_STORAGE_KEY = "jlms-policy-expanded:v1";
const EXPAND_BATCH_SIZE = 6;

type DelayValue = number | null;

type PolicyGroup = {
  name: string;
  type: string;
  now?: string;
  nodes: string[];
  history?: { time: string; delay: number }[];
};

function isPolicyGroup(node: ProxyNode): node is ProxyNode & { all: string[] } {
  return Array.isArray(node.all) && node.all.length > 0;
}

function toGroups(data: ProxiesResponse | null): PolicyGroup[] {
  if (!data?.proxies || typeof data.proxies !== "object") return [];
  return Object.entries(data.proxies)
    .flatMap(([name, node]) =>
      isPolicyGroup(node)
        ? [
            {
              name,
              type: node.type,
              now: node.now,
              nodes: node.all ?? [],
              history: node.history,
            },
          ]
        : [],
    );
}

function latestDelay(group: PolicyGroup): number | undefined {
  const history = group.history ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const value = history[i]?.delay;
    if (typeof value === "number" && value > 0) {
      return value;
    }
  }
  return undefined;
}

function toneForDelay(delay: DelayValue | undefined) {
  if (delay === undefined || delay === null) return "none";
  if (delay < 200) return "good";
  if (delay < 800) return "mid";
  return "bad";
}

function labelForDelay(delay: DelayValue | undefined) {
  if (delay === undefined) return "未测";
  if (delay === null) return "超时";
  return `${delay} ms`;
}

function allTestingKey(name: string) {
  return `all:${name}`;
}

function groupTestingKey(group: string, name: string) {
  return `${group}::${name}`;
}

function loadExpandedGroups() {
  if (typeof window === "undefined") return {} as Record<string, boolean>;
  try {
    const raw = window.localStorage.getItem(POLICY_EXPANDED_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function saveExpandedGroups(expanded: Record<string, boolean>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(POLICY_EXPANDED_STORAGE_KEY, JSON.stringify(expanded));
  } catch {
    /* ignore storage failures */
  }
}

type DelayProgressPayload = {
  request_id: string;
  name: string;
  delay?: number | null;
};

type ProxySelectionChangedPayload = {
  group: string;
  name: string;
};

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

export function Policies() {
  const [data, setData] = useState<ProxiesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [measureBusy, setMeasureBusy] = useState<string | null>(null);
  const [selecting, setSelecting] = useState<{ group: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => loadExpandedGroups());
  const [delays, setDelays] = useState<Record<string, DelayValue | undefined>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const activeMeasureRequestRef = useRef<string>("");
  const localSelectionRef = useRef<string>("");
  const expandFrameRef = useRef<number | null>(null);
  const expandQueueRef = useRef<string[]>([]);
  const expandedSaveTimerRef = useRef<number | null>(null);

  const groups = useMemo(() => toGroups(data), [data]);
  const allNodes = useMemo(
    () => Array.from(new Set(groups.flatMap((group) => group.nodes))),
    [groups],
  );
  const activeCount = useMemo(() => groups.filter((group) => group.now).length, [groups]);
  const allExpanded = useMemo(
    () => groups.length > 0 && groups.every((group) => expanded[group.name] ?? false),
    [expanded, groups],
  );
  const bestDelay = useMemo(() => {
    const values = Object.values(delays).filter((value): value is number => typeof value === "number");
    if (values.length === 0) return undefined;
    return Math.min(...values);
  }, [delays]);

  const load = useCallback(async () => {
    try {
      const next = await api.proxiesGet();
      const nextGroups = toGroups(next);
      setData(next);
      setExpanded((prev) => {
        const merged = { ...prev };
        nextGroups.forEach((group, index) => {
          if (!(group.name in merged)) {
            merged[group.name] = index < 4;
          }
        });
        return merged;
      });
      setDelays((prev) => {
        const merged = { ...prev };
        nextGroups.forEach((group) => {
          const delay = latestDelay(group);
          if (group.now && delay !== undefined && merged[group.now] === undefined) {
            merged[group.now] = delay;
          }
        });
        return merged;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (expandedSaveTimerRef.current !== null) {
      window.clearTimeout(expandedSaveTimerRef.current);
    }
    expandedSaveTimerRef.current = window.setTimeout(() => {
      saveExpandedGroups(expanded);
      expandedSaveTimerRef.current = null;
    }, 120);
    return () => {
      if (expandedSaveTimerRef.current !== null) {
        window.clearTimeout(expandedSaveTimerRef.current);
        expandedSaveTimerRef.current = null;
      }
    };
  }, [expanded]);

  useEffect(() => {
    const unlistenPromise = listen<DelayProgressPayload>("policy://delay-progress", (event) => {
      const payload = event.payload;
      if (!payload || payload.request_id !== activeMeasureRequestRef.current) {
        return;
      }
      setDelays((prev) => ({
        ...prev,
        [payload.name]: payload.delay ?? null,
      }));
    });

    return () => {
      void unlistenPromise.then((off) => off());
    };
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<ProxySelectionChangedPayload>("proxy://selection-changed", (event) => {
      const payload = event.payload;
      if (!payload) return;
      const key = `${payload.group}::${payload.name}`;
      setData((prev) => applyProxySelection(prev, payload));
      if (localSelectionRef.current === key) {
        localSelectionRef.current = "";
      }
    });

    return () => {
      void unlistenPromise.then((off) => off());
    };
  }, [load]);

  const cancelExpandFrames = useCallback(() => {
    expandQueueRef.current = [];
    if (expandFrameRef.current !== null) {
      window.cancelAnimationFrame(expandFrameRef.current);
      expandFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      cancelExpandFrames();
    };
  }, [cancelExpandFrames]);

  const toggleGroup = (name: string) => {
    cancelExpandFrames();
    startTransition(() => {
      setExpanded((prev) => ({ ...prev, [name]: !prev[name] }));
    });
  };

  const setAllExpanded = (value: boolean) => {
    cancelExpandFrames();

    if (!value) {
      startTransition(() => {
        setExpanded(Object.fromEntries(groups.map((group) => [group.name, false])));
      });
      return;
    }

    const names = groups.map((group) => group.name);
    const initial = names.slice(0, EXPAND_BATCH_SIZE);
    expandQueueRef.current = names.slice(EXPAND_BATCH_SIZE);

    startTransition(() => {
      setExpanded((prev) => {
        const next = { ...prev };
        initial.forEach((name) => {
          next[name] = true;
        });
        return next;
      });
    });

    const flushNextBatch = () => {
      const batch = expandQueueRef.current.splice(0, EXPAND_BATCH_SIZE);
      if (batch.length === 0) {
        expandFrameRef.current = null;
        return;
      }

      startTransition(() => {
        setExpanded((prev) => {
          const next = { ...prev };
          batch.forEach((name) => {
            next[name] = true;
          });
          return next;
        });
      });

      if (expandQueueRef.current.length > 0) {
        expandFrameRef.current = window.requestAnimationFrame(flushNextBatch);
      } else {
        expandFrameRef.current = null;
      }
    };

    if (expandQueueRef.current.length > 0) {
      expandFrameRef.current = window.requestAnimationFrame(flushNextBatch);
    }
  };

  const measureMany = useCallback(async (names: string[], busyKey: string, groupName?: string) => {
    const unique = Array.from(new Set(names));
    if (unique.length === 0) return;
    const requestId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    activeMeasureRequestRef.current = requestId;
    setMeasureBusy(busyKey);
    setError(null);
    const keys = unique.map((name) => (groupName ? groupTestingKey(groupName, name) : allTestingKey(name)));
    setTesting((prev) => ({
      ...prev,
      ...Object.fromEntries(keys.map((key) => [key, true])),
    }));
    try {
      const measured = await api.proxyDelayMany(unique, requestId);
      setDelays((prev) => ({
        ...prev,
        ...Object.fromEntries(unique.map((name) => [name, name in measured ? measured[name] : null])),
      }));
    } catch {
      setDelays((prev) => ({
        ...prev,
        ...Object.fromEntries(unique.map((name) => [name, null])),
      }));
    } finally {
      setTesting((prev) => {
        const next = { ...prev };
        keys.forEach((key) => delete next[key]);
        return next;
      });
      activeMeasureRequestRef.current = "";
      setMeasureBusy(null);
    }
  }, []);

  const selectNode = useCallback(
    async (group: string, name: string) => {
      localSelectionRef.current = `${group}::${name}`;
      setSelecting({ group, name });
      setError(null);
      try {
        await api.proxySelect(group, name);
      } catch (e) {
        localSelectionRef.current = "";
        setError(String(e));
      } finally {
        setSelecting((current) => (current?.group === group && current?.name === name ? null : current));
      }
    },
    [],
  );

  const pageBusy = !!measureBusy || !!selecting;

  return (
    <div className="view policies-view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">Proxies</div>
          <h1 className="activity-title">Policy</h1>
          <p className="page-hero-sub">查看策略组当前节点，手动切换并对候选节点执行延迟测试。</p>
        </div>
      </section>

      <div className="metrics metrics-compact">
        <div className="metric">
          <div className="metric-label">策略组</div>
          <div className="metric-value">{groups.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">候选节点</div>
          <div className="metric-value">{allNodes.length}</div>
        </div>
        <div className="metric">
          <div className="metric-label">已选择</div>
          <div className="metric-value">{activeCount}</div>
        </div>
        <div className="metric">
          <div className="metric-label">最佳延迟</div>
          <div className="metric-value">{bestDelay !== undefined ? `${bestDelay} ms` : "未测"}</div>
        </div>
      </div>

      <div className="toolbar toolbar-flat">
        <div className="toolbar-note">共 {groups.length} 个策略组，点击分组展开节点；点击节点即可切换。</div>
        <div className="toolbar-actions">
          <button className="sm ghost" onClick={() => void load()} disabled={pageBusy}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="sm ghost" onClick={() => setAllExpanded(!allExpanded)} disabled={groups.length === 0 || pageBusy}>
            {allExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {allExpanded ? "收起全部" : "展开全部"}
          </button>
          <button
            className="sm"
            onClick={() => void measureMany(allNodes, "measure:all")}
            disabled={allNodes.length === 0 || pageBusy}
          >
            <TimerReset size={13} />
            {measureBusy === "measure:all" ? "测速中…" : "全部测速"}
          </button>
        </div>
      </div>

      {error && <div className="banner error">⚠ {error}</div>}

      {groups.length === 0 ? (
        <div className="empty">暂无策略组。请先启用订阅并确保内核已成功启动。</div>
      ) : (
        <div className="policy-group-list">
          {groups.map((group) => {
            const open = expanded[group.name] ?? false;
            const groupBusy = measureBusy === `measure:${group.name}`;
            const selectingName = selecting?.group === group.name ? selecting.name : null;
            return (
              <PolicyGroupSection
                key={group.name}
                group={group}
                open={open}
                groupBusy={groupBusy}
                selectingName={selectingName}
                measuring={!!measureBusy}
                delays={delays}
                testing={testing}
                onToggle={toggleGroup}
                onMeasure={measureMany}
                onSelect={selectNode}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

const PolicyGroupSection = memo(function PolicyGroupSection({
  group,
  open,
  groupBusy,
  selectingName,
  measuring,
  delays,
  testing,
  onToggle,
  onMeasure,
  onSelect,
}: {
  group: PolicyGroup;
  open: boolean;
  groupBusy: boolean;
  selectingName: string | null;
  measuring: boolean;
  delays: Record<string, DelayValue | undefined>;
  testing: Record<string, boolean>;
  onToggle: (name: string) => void;
  onMeasure: (names: string[], busyKey: string, groupName?: string) => Promise<void>;
  onSelect: (group: string, name: string) => Promise<void>;
}) {
  return (
    <section className="group surge-group">
      <div className="group-head" onClick={() => onToggle(group.name)}>
        <ChevronRight size={15} className={open ? "chevron open" : "chevron"} />
        <div>
          <div className="group-name">{group.name}</div>
          <div className="group-meta">
            <span className="group-type">{group.type}</span>
            <span>{group.nodes.length} 个候选</span>
          </div>
        </div>
        <div className="group-now">
          <span className="group-now-label">当前</span>
          {group.now ?? "未选择"}
        </div>
        <div className="group-actions" onClick={(e) => e.stopPropagation()}>
          <button
            className="sm ghost icon-button"
            onClick={() => void onMeasure(group.nodes, `measure:${group.name}`, group.name)}
            disabled={measuring || !!selectingName}
            title="测速"
            aria-label="测速"
          >
            {groupBusy ? <LoaderCircle size={15} className="spin" /> : <TimerReset size={15} />}
          </button>
        </div>
      </div>

      {open && (
        <div className="group-nodes">
          {group.nodes.map((name) => {
            const active = group.now === name;
            const delay =
              delays[name] !== undefined ? delays[name] : active ? latestDelay(group) : undefined;
            const isSelecting = selectingName === name;
            const isTesting = !!testing[groupTestingKey(group.name, name)] || !!testing[allTestingKey(name)];
            return (
              <button
                key={`${group.name}:${name}`}
                type="button"
                className={`node-chip ${active ? "active" : ""}`}
                onClick={() => void onSelect(group.name, name)}
                disabled={active || isTesting || measuring || !!selectingName}
                title={name}
              >
                <span className="node-stack">
                  <span className="node-title-row">
                    <span className="nm">{name}</span>
                    {active && <span className="node-inline-badge">当前</span>}
                  </span>
                </span>
                <span className={`latency ${toneForDelay(delay)}`}>
                  {isSelecting ? "切换中…" : isTesting ? "测速中…" : labelForDelay(delay)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
});
