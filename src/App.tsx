import { useCallback, useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowUpRight,
  BellRing,
  RefreshCw,
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

type ReleaseInfo = {
  tag_name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
};

type UpdateBannerState = {
  version: string;
  url: string;
};

const VIEW_META: Record<View, { title: string }> = {
  overview: { title: "概览" },
  requests: { title: "进程" },
  policy: { title: "策略" },
  profiles: { title: "订阅" },
  logs: { title: "日志" },
  settings: { title: "设置" },
};

const NAV_SECTIONS: {
  title: string;
  items: { id: View; label: string; Icon: LucideIcon }[];
}[] = [
  {
    title: "概览",
    items: [{ id: "overview", label: "概览", Icon: LayoutGrid }],
  },
  {
    title: "客户端",
    items: [{ id: "requests", label: "进程", Icon: Laptop2 }],
  },
  {
    title: "代理",
    items: [
      { id: "policy", label: "策略", Icon: Network },
      { id: "profiles", label: "订阅", Icon: Waypoints },
    ],
  },
  {
    title: "系统",
    items: [
      { id: "settings", label: "设置", Icon: SlidersHorizontal },
      { id: "logs", label: "日志", Icon: Logs },
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
const RELEASES_LATEST_API = "https://api.github.com/repos/barbara012/jlms/releases/latest";
const GITHUB_REPO_URL = "https://github.com/barbara012/jlms";
const IGNORED_UPDATE_VERSION_KEY = "jlms-ignored-update-version:v1";

function normalizeVersion(version: string) {
  return version.trim().replace(/^[vV]/, "");
}

function compareVersions(current: string, next: string) {
  const currentParts = normalizeVersion(current)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const nextParts = normalizeVersion(next)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(currentParts.length, nextParts.length);

  for (let index = 0; index < length; index += 1) {
    const left = currentParts[index] ?? 0;
    const right = nextParts[index] ?? 0;
    if (left !== right) {
      return left - right;
    }
  }

  return 0;
}

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
  const [appVersion, setAppVersion] = useState<string>("—");
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [systemProxy, setSystemProxy] = useState<SystemProxyStatus | null>(null);
  const [coreError, setCoreError] = useState<string | null>(null);
  const [updateBanner, setUpdateBanner] = useState<UpdateBannerState | null>(null);
  const [updateCheckBusy, setUpdateCheckBusy] = useState(false);
  const [updateCheckMessage, setUpdateCheckMessage] = useState<string | null>(null);
  const [ignoredUpdateVersion, setIgnoredUpdateVersionState] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(IGNORED_UPDATE_VERSION_KEY);
    } catch {
      return null;
    }
  });

  const setIgnoredUpdateVersion = useCallback((version: string | null) => {
    try {
      if (!version) {
        window.localStorage.removeItem(IGNORED_UPDATE_VERSION_KEY);
      } else {
        window.localStorage.setItem(IGNORED_UPDATE_VERSION_KEY, version);
      }
    } catch {
      /* ignore storage access failures */
    }
    setIgnoredUpdateVersionState(version);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await api.coreStatus();
      setCoreError((prev) => {
        if (next.running || !next.has_profiles) {
          return null;
        }
        return prev ?? "内核未启动，代理不可用。请检查 mihomo sidecar 是否被系统拦截或损坏。";
      });
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
      setCoreError(null);
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

  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };

    document.addEventListener("contextmenu", preventContextMenu);
    return () => document.removeEventListener("contextmenu", preventContextMenu);
  }, []);

  useEffect(() => {
    void getVersion()
      .then((version) => setAppVersion(normalizeVersion(version)))
      .catch(() => {
        /* ignore app version lookup failures */
      });
  }, []);

  const checkForAppUpdate = useCallback(async (manual = false) => {
    if (manual) {
      setUpdateCheckBusy(true);
      setUpdateCheckMessage(null);
    }

    try {
      const [currentVersion, response] = await Promise.all([
        getVersion(),
        fetch(RELEASES_LATEST_API, {
          headers: {
            Accept: "application/vnd.github+json",
          },
        }),
      ]);
      if (!response.ok) {
        throw new Error(`request failed: ${response.status}`);
      }

      const release = (await response.json()) as ReleaseInfo;
      if (release.draft || release.prerelease) {
        if (manual) {
          setUpdateCheckMessage("暂未发现可用的正式版本。");
        }
        return;
      }

      const latestVersion = release.tag_name ? normalizeVersion(release.tag_name) : "";
      const releaseUrl = release.html_url?.trim();
      if (!latestVersion || !releaseUrl) {
        if (manual) {
          setUpdateCheckMessage("暂时无法获取更新信息。");
        }
        return;
      }

      if (compareVersions(currentVersion, latestVersion) < 0) {
        if (ignoredUpdateVersion !== latestVersion || manual) {
          setUpdateBanner({
            version: latestVersion,
            url: releaseUrl,
          });
        }
        if (manual) {
          setUpdateCheckMessage(`发现新版本 JLMS ${latestVersion}，可直接前往下载。`);
        }
        return;
      }

      setUpdateBanner(null);
      if (manual) {
        setUpdateCheckMessage(`当前已是最新版本（${normalizeVersion(currentVersion)}）。`);
      }
    } catch {
      if (manual) {
        setUpdateCheckMessage("检查更新失败，请稍后再试。");
      }
      /* silent: update check should never block app startup */
    } finally {
      if (manual) {
        setUpdateCheckBusy(false);
      }
    }
  }, [ignoredUpdateVersion]);

  useEffect(() => {
    void checkForAppUpdate();
  }, [checkForAppUpdate]);

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

  const openLatestRelease = async () => {
    if (!updateBanner?.url) return;
    try {
      await openUrl(updateBanner.url);
    } catch {
      /* ignore external opener failures */
    }
  };

  const openRepository = async () => {
    try {
      await openUrl(GITHUB_REPO_URL);
    } catch {
      /* ignore external opener failures */
    }
  };

  const dismissUpdateBanner = useCallback(() => {
    if (!updateBanner?.version) return;
    setIgnoredUpdateVersion(updateBanner.version);
    setUpdateBanner(null);
    setUpdateCheckMessage(`已忽略 JLMS ${updateBanner.version} 的更新提示，发现更高版本后会再次提醒。`);
  }, [setIgnoredUpdateVersion, updateBanner]);

  const restoreUpdateReminder = useCallback(async () => {
    setIgnoredUpdateVersion(null);
    await checkForAppUpdate(true);
  }, [checkForAppUpdate, setIgnoredUpdateVersion]);

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
            <div className="brand-title-row">
              <h1>JLMS</h1>
              {updateBanner ? (
                <span className="brand-update-badge">新版本 {updateBanner.version}</span>
              ) : (
                <span className="brand-version-text">{appVersion}</span>
              )}
            </div>
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
            <div className="sidebar-kernel-row">
              <div className="sidebar-kernel-main">
                {running ? <span className="sidebar-live-dot" aria-label="内核运行中" title="内核运行中" /> : null}
                <b className="sidebar-kernel-status">
                  内核（{status?.version ?? "—"}）{running ? "" : "已停止"}
                </b>
              </div>
              <span className="sidebar-kernel-port">端口 {status?.mixed_port ?? 7890}</span>
            </div>
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
            <div className="segmented mode-segmented">
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

        {updateBanner && view !== "settings" && (
          <div className="banner info app-top-banner update-banner">
            <div className="update-banner-main">
              <div className="update-banner-icon">
                <BellRing size={15} />
              </div>
              <div className="update-banner-copy">
                <div className="update-banner-title">发现新版本 JLMS {updateBanner.version}</div>
                <div className="update-banner-text">当前版本可继续使用，点击即可前往 GitHub Releases 下载更新。</div>
              </div>
            </div>
            <div className="update-banner-actions">
              <button className="update-banner-button" onClick={() => void openLatestRelease()}>
                前往下载
                <ArrowUpRight size={14} />
              </button>
              <button className="update-banner-close" onClick={dismissUpdateBanner}>
                忽略此版本
              </button>
            </div>
          </div>
        )}

        {view === "overview" && <Overview status={status} />}

        {view === "policy" && <Policies />}

        {view === "requests" && <Requests />}

        {view === "profiles" && <Profiles onChanged={refresh} />}

        {view === "logs" && <LogsView />}

        {view === "settings" && (
          <SettingsView
            themePreference={themePreference}
            onThemeChange={setThemePreference}
            updateBanner={updateBanner}
            ignoredUpdateVersion={ignoredUpdateVersion}
            updateCheckBusy={updateCheckBusy}
            updateCheckMessage={updateCheckMessage}
            onCheckUpdate={() => void checkForAppUpdate(true)}
            onOpenLatestRelease={() => void openLatestRelease()}
            onOpenRepository={() => void openRepository()}
            onRestoreUpdateReminder={() => void restoreUpdateReminder()}
          />
        )}

      </main>
    </div>
  );
}

export default App;

function SettingsView({
  themePreference,
  onThemeChange,
  updateBanner,
  ignoredUpdateVersion,
  updateCheckBusy,
  updateCheckMessage,
  onCheckUpdate,
  onOpenLatestRelease,
  onOpenRepository,
  onRestoreUpdateReminder,
}: {
  themePreference: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  updateBanner: UpdateBannerState | null;
  ignoredUpdateVersion: string | null;
  updateCheckBusy: boolean;
  updateCheckMessage: string | null;
  onCheckUpdate: () => void;
  onOpenLatestRelease: () => void;
  onOpenRepository: () => void;
  onRestoreUpdateReminder: () => void;
}) {
  return (
    <div className="view settings-view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">系统</div>
          <h1 className="activity-title">设置</h1>
          <p className="page-hero-sub">管理主题与系统层偏好设置。</p>
        </div>
      </section>

      <div className="settings-grid">
        <section className="surge-card settings-card">
          <div className="settings-card-title">主题</div>

          <div className="segmented settings-theme-segmented" aria-label="主题设置">
            {THEMES.map(({ id, label, Icon }) => (
              <button key={id} className={themePreference === id ? "active" : ""} onClick={() => onThemeChange(id)}>
                <Icon size={13} />
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="surge-card settings-card">
          <div className="settings-card-title">更新</div>
          <div className="settings-actions">
            <button className="settings-action-button" onClick={onCheckUpdate} disabled={updateCheckBusy}>
              <RefreshCw size={14} className={updateCheckBusy ? "spin" : ""} />
              {updateCheckBusy ? "检查中…" : "检查更新"}
            </button>
            {updateBanner && (
              <button className="settings-action-button ghost" onClick={onOpenLatestRelease}>
                前往下载
                <ArrowUpRight size={14} />
              </button>
            )}
            {ignoredUpdateVersion && (
              <button className="settings-action-button ghost" onClick={onRestoreUpdateReminder} disabled={updateCheckBusy}>
                恢复提醒
              </button>
            )}
          </div>
          <div className="settings-update-text">
            {updateCheckMessage ??
              (updateBanner
                ? (
                  <>
                    当前发现新版本 JLMS {updateBanner.version}，你可以直接跳转到
                    <button type="button" className="settings-inline-link" onClick={onOpenRepository}>
                      GitHub
                    </button>
                    仓库查看发布信息。
                  </>
                )
                : ignoredUpdateVersion
                  ? `当前已忽略 JLMS ${ignoredUpdateVersion} 的更新提示，你可以随时恢复提醒。`
                  : (
                    <>
                      手动检查
                      <button type="button" className="settings-inline-link" onClick={onOpenRepository}>
                        GitHub
                      </button>
                      仓库中是否已有新版本。
                    </>
                  ))}
          </div>
        </section>
      </div>
    </div>
  );
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
          <div className="activity-kicker">系统</div>
          <h1 className="activity-title">日志</h1>
          <p className="page-hero-sub">查看 Mihomo 内核输出与运行时事件，便于排查连接和订阅问题。</p>
        </div>
      </section>
      <div className="logs logs-surge">
        <div className="logs-head">
          <div className="logs-head-main">
            <div className="logs-head-sub">最近 {logs.length} 条运行日志</div>
          </div>
        </div>
        <div className={logs.length === 0 ? "logs-body logs-body-empty" : "logs-body"}>
          {logs.length === 0 ? (
            <div className="logs-empty">
              <div className="logs-empty-icon">
                <Logs size={22} />
              </div>
              <div className="logs-empty-title">暂无运行日志</div>
              <div className="logs-empty-text">Mihomo 内核启动并产生输出后，这里会实时显示最新日志。</div>
            </div>
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
