import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Laptop2,
  LayoutGrid,
  type LucideIcon,
  Logs,
  Monitor,
  MoonStar,
  Network,
  ShieldCheck,
  SlidersHorizontal,
  SunMedium,
  Waypoints,
} from "lucide-react";
import sidebarLogo from "./assets/sidebar-logo.png";
import { api, type CoreStatus, type SystemProxyStatus } from "./api";
import { Overview } from "./Overview";
import { Policies } from "./Policies";
import { Profiles } from "./Profiles";
import { Requests } from "./Requests";
import "./App.css";

type View = "overview" | "policy" | "requests" | "profiles" | "logs" | "settings";
type Theme = "light" | "dark";
type ThemePreference = Theme | "system";
type ModeChangedPayload = {
  mode: string;
  default_group: string;
};

const VIEW_META: Record<View, { title: string }> = {
  overview: { title: "Overview" },
  requests: { title: "Process" },
  policy: { title: "Policy" },
  profiles: { title: "Profile" },
  logs: { title: "Logs" },
  settings: { title: "Settings" },
};

const NAV_SECTIONS: {
  title: string;
  items: { id: View; label: string; Icon: LucideIcon }[];
}[] = [
  {
    title: "Activity",
    items: [{ id: "overview", label: "Overview", Icon: LayoutGrid }],
  },
  {
    title: "Clients",
    items: [{ id: "requests", label: "Process", Icon: Laptop2 }],
  },
  {
    title: "Proxies",
    items: [
      { id: "policy", label: "Policy", Icon: Network },
      { id: "profiles", label: "Profile", Icon: Waypoints },
    ],
  },
  {
    title: "System",
    items: [
      { id: "settings", label: "Settings", Icon: SlidersHorizontal },
      { id: "logs", label: "Logs", Icon: Logs },
    ],
  },
];

const MODES = [
  { id: "direct", label: "直连" },
  { id: "global", label: "全局" },
  { id: "rule", label: "规则" },
];

const THEME_STORAGE_KEY = "jlms-theme:v1";
const THEMES: { id: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { id: "system", label: "跟随系统", Icon: Monitor },
  { id: "light", label: "亮色", Icon: SunMedium },
  { id: "dark", label: "暗色", Icon: MoonStar },
];

function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";

  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "system" || saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore storage access failures */
  }

  return "system";
}

function App() {
  const [view, setView] = useState<View>("overview");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => getInitialThemePreference());
  const [systemTheme, setSystemTheme] = useState<Theme>(() => getSystemTheme());
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [systemProxy, setSystemProxy] = useState<SystemProxyStatus | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.coreStatus();
      setCoreError((prev) =>
        next.running ? null : prev ?? "内核未启动，代理不可用。请检查 mihomo sidecar 是否被系统拦截或损坏。"
      );
      setStatus((prev) =>
        prev &&
        prev.running === next.running &&
        prev.version === next.version &&
        prev.mixed_port === next.mixed_port &&
        prev.controller === next.controller &&
        prev.mode === next.mode &&
        prev.default_group === next.default_group
          ? prev
          : next,
      );
    } catch {
      /* core may be restarting */
    }
    try {
      const next = await api.systemProxyStatus();
      setSystemProxy((prev) =>
        prev &&
        prev.enabled === next.enabled &&
        prev.host === next.host &&
        prev.port === next.port &&
        prev.services.length === next.services.length &&
        prev.services.every((service, index) => service === next.services[index])
          ? prev
          : next,
      );
    } catch {
      /* allow UI to stay responsive when core/system proxy is unavailable */
    }
  }, []);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh();
      }
    };

    void refresh();
    const timer = setInterval(refreshIfVisible, 10000);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);

  useEffect(() => {
    const errorPromise = listen<string>("core://error", (event) => {
      setCoreError(event.payload || "内核未启动，代理不可用。");
      void refresh();
    });
    const exitPromise = listen<number | null>("core://exit", () => {
      setCoreError("内核未启动，代理不可用。请检查 mihomo sidecar 是否被系统拦截或损坏。");
      void refresh();
    });

    return () => {
      void errorPromise.then((off) => off());
      void exitPromise.then((off) => off());
    };
  }, [refresh]);

  useEffect(() => {
    const proxyPromise = listen<SystemProxyStatus>("system-proxy://changed", (event) => {
      setSystemProxy(event.payload);
    });
    const modePromise = listen<ModeChangedPayload>("core://mode-changed", (event) => {
      const payload = event.payload;
      if (!payload) {
        void refresh();
        return;
      }
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              mode: payload.mode,
              default_group: payload.default_group,
            }
          : prev,
      );
    });

    return () => {
      void proxyPromise.then((off) => off());
      void modePromise.then((off) => off());
    };
  }, [refresh]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => setSystemTheme(media.matches ? "dark" : "light");

    applySystemTheme();
    media.addEventListener("change", applySystemTheme);
    return () => media.removeEventListener("change", applySystemTheme);
  }, []);

  const resolvedTheme = themePreference === "system" ? systemTheme : themePreference;

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch {
      /* ignore storage access failures */
    }
  }, [resolvedTheme, themePreference]);

  const changeMode = async (mode: string) => {
    try {
      await api.setMode(mode);
    } catch {
      /* ignore */
    }
  };

  const startTopbarDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    void getCurrentWindow().startDragging();
  };

  const running = status?.running ?? false;
  const currentMeta = VIEW_META[view];

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-drag" data-tauri-drag-region />
        <div className="brand">
          <span className="brand-mark">
            <img src={sidebarLogo} alt="JLMS" />
          </span>
          <div className="brand-text">
            <h1>JLMS</h1>
            <p>Mihomo 内核</p>
          </div>
        </div>
        <nav className="nav">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="nav-section">
              <div className="nav-section-title">{section.title}</div>
              <div className="nav-section-items">
                {section.items.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    className={view === id ? "nav-item active" : "nav-item"}
                    onClick={() => setView(id)}
                  >
                    <Icon size={16} className="nav-icon" strokeWidth={2} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-status">
            <b>{running ? "内核运行中" : "已停止"}</b>
            <span>{status?.version ?? "—"}</span>
            <span>端口 {status?.mixed_port ?? 7890}</span>
          </div>
        </div>
      </aside>

      <main className="content">
        <div
          className="window-drag-zone"
          data-tauri-drag-region
          aria-hidden="true"
          onMouseDown={startTopbarDrag}
        />
        <div className="topbar">
          <div className="topbar-main" onMouseDown={startTopbarDrag}>
            <div className="topbar-context">
              <span className="topbar-title-main">{currentMeta.title}</span>
            </div>
          </div>
          <div className="topbar-drag-spacer" aria-hidden="true" onMouseDown={startTopbarDrag} />
          <div className="topbar-actions">
            <div className="status-pills compact">
              <div className={`status-pill ${systemProxy?.enabled ? "on" : "off"}`}>
                <ShieldCheck size={13} />
                <span>{systemProxy?.enabled ? "系统代理已开启" : "系统代理已关闭"}</span>
              </div>
            </div>
            <div className="segmented">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={status?.mode === m.id ? "active" : ""}
                  disabled={!running}
                  onClick={() => changeMode(m.id)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {coreError && <div className="banner error app-top-banner">⚠ {coreError}</div>}

        {view === "overview" && <Overview status={status} />}

        {view === "policy" && <Policies />}

        {view === "requests" && <Requests />}

        {view === "profiles" && <Profiles onChanged={refresh} />}

        {view === "logs" && <LogsView />}

        {view === "settings" && (
          <SettingsView
            themePreference={themePreference}
            resolvedTheme={resolvedTheme}
            systemTheme={systemTheme}
            onThemeChange={setThemePreference}
          />
        )}

      </main>
    </div>
  );
}

export default App;

function SettingsView({
  themePreference,
  resolvedTheme,
  systemTheme,
  onThemeChange,
}: {
  themePreference: ThemePreference;
  resolvedTheme: Theme;
  systemTheme: Theme;
  onThemeChange: (theme: ThemePreference) => void;
}) {
  return (
    <div className="view settings-view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">System</div>
          <h1 className="activity-title">Settings</h1>
          <p className="page-hero-sub">管理主题与系统层偏好设置。</p>
        </div>
      </section>

      <div className="settings-grid">
        <section className="surge-card settings-card">
          <div className="settings-card-title">Theme</div>

          <div className="segmented settings-theme-segmented" aria-label="主题设置">
            {THEMES.map(({ id, label, Icon }) => (
              <button key={id} className={themePreference === id ? "active" : ""} onClick={() => onThemeChange(id)}>
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>

          <div className="settings-facts">
            <div className="settings-fact">
              <span>当前偏好</span>
              <b>{themeLabel(themePreference)}</b>
            </div>
            <div className="settings-fact">
              <span>系统主题</span>
              <b>{themeLabel(systemTheme)}</b>
            </div>
            <div className="settings-fact">
              <span>实际生效</span>
              <b>{themeLabel(resolvedTheme)}</b>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function themeLabel(theme: ThemePreference | Theme) {
  if (theme === "system") return "跟随系统";
  return theme === "dark" ? "暗色" : "亮色";
}

function LogsView() {
  const [logs, setLogs] = useState<string[]>([]);
  const pendingLogsRef = useRef<string[]>([]);
  const flushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    const flush = () => {
      flushTimerRef.current = null;
      if (!active || pendingLogsRef.current.length === 0) return;
      const batch = pendingLogsRef.current;
      pendingLogsRef.current = [];
      setLogs((prev) => [...prev, ...batch].slice(-500));
    };
    const scheduleFlush = () => {
      if (flushTimerRef.current !== null) return;
      flushTimerRef.current = window.setTimeout(flush, 120);
    };
    const unlistenPromise = listen<string>("core://log", (e) => {
      if (!active) return;
      pendingLogsRef.current.push(e.payload);
      scheduleFlush();
    });

    return () => {
      active = false;
      pendingLogsRef.current = [];
      if (flushTimerRef.current !== null) {
        window.clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      void unlistenPromise.then((off) => off());
    };
  }, []);

  return (
    <div className="view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">System</div>
          <h1 className="activity-title">Logs</h1>
          <p className="page-hero-sub">查看 Mihomo 内核输出与运行时事件，便于排查连接和订阅问题。</p>
        </div>
      </section>
      <div className="logs logs-surge">
        <div className="logs-head">
          <div className="logs-head-main">
            <div className="surge-card-label">Runtime Console</div>
            <div className="logs-head-sub">最近 {logs.length} 条运行日志</div>
          </div>
        </div>
        <div className="logs-body">
          {logs.length === 0 ? (
            <div className="logs-empty">暂无日志…</div>
          ) : (
            logs.map((line, i) => (
              <div key={i} className="log-line">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
