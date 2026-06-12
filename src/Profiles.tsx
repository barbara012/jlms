import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Inbox, LoaderCircle, Play, RefreshCw, Trash2 } from "lucide-react";
import { api, type ProfilesIndex } from "./api";

function fmtTime(secs?: number) {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toLocaleString();
}

export function Profiles({ onChanged }: { onChanged?: () => void }) {
  const [index, setIndex] = useState<ProfilesIndex>({ active: null, profiles: [] });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIndex(await api.profilesList());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>) => {
      setBusy(key);
      setError(null);
      try {
        await fn();
        await load();
        onChanged?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged],
  );

  const onImport = () => {
    const value = url.trim();
    if (!value) return;
    run("import", async () => {
      await api.profilesImport(value);
      setUrl("");
    });
  };

  const onImportFile = () => {
    run("importfile", async () => {
      const path = await open({
        multiple: false,
        directory: false,
        filters: [{ name: "Clash 配置", extensions: ["yaml", "yml"] }],
      });
      if (typeof path === "string") {
        await api.profilesImportFile(path);
      }
    });
  };

  return (
    <div className="view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">Proxies</div>
          <h1 className="activity-title">Profile</h1>
          <p className="page-hero-sub">导入 Clash / mihomo 格式订阅，激活后内核即按其节点与规则运行。</p>
        </div>
      </section>

      <section className="surge-card profile-import-strip">
        <div className="profile-import-label">导入订阅</div>
        <div className="import-row profile-import-row">
          <input
            placeholder="粘贴订阅链接 (https://…)"
            value={url}
            onChange={(e) => setUrl(e.currentTarget.value)}
            onKeyDown={(e) => e.key === "Enter" && onImport()}
          />
          <div className="toolbar-actions">
            <button onClick={onImport} disabled={busy === "import" || !url.trim()}>
              {busy === "import" ? "导入中…" : "导入 URL"}
            </button>
            <button className="ghost" onClick={onImportFile} disabled={busy === "importfile"}>
              {busy === "importfile" ? "导入中…" : "本地文件"}
            </button>
          </div>
        </div>
      </section>

      {error && <div className="banner error">⚠ {error}</div>}

      <div className="profile-list">
        {index.profiles.length === 0 ? (
          <div className="profile-empty">
            <div className="profile-empty-icon">
              <Inbox size={22} />
            </div>
            <div className="profile-empty-title">还没有订阅</div>
            <div className="profile-empty-text">粘贴订阅链接或导入本地配置后，这里会显示可用的配置列表。</div>
          </div>
        ) : (
          index.profiles.map((p) => {
            const active = p.id === index.active;
            return (
              <div key={p.id} className={`profile-card ${active ? "active" : ""}`}>
                <div className="profile-main">
                  <div className="profile-row-top">
                    <div className="profile-name">
                      {p.name}
                      {active && <span className="badge">已启用</span>}
                    </div>
                    <div className="profile-row-kind">{p.type === "subscription" ? "订阅" : "本地"}</div>
                  </div>
                  <div className="profile-sub">
                    {p.updated_at ? `更新于 ${fmtTime(p.updated_at)}` : "未记录更新时间"}
                  </div>
                  {p.url && <div className="profile-url">{p.url}</div>}
                </div>
                <div className="profile-actions">
                  {!active && (
                    <button
                      className="sm icon-button"
                      onClick={() => run(`sel-${p.id}`, () => api.profilesSelect(p.id))}
                      disabled={!!busy}
                      title="启用"
                      aria-label="启用"
                    >
                      {busy === `sel-${p.id}` ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                    </button>
                  )}
                  <button
                    className="sm ghost icon-button"
                    onClick={() => run(`upd-${p.id}`, () => api.profilesUpdate(p.id))}
                    disabled={!!busy || p.type !== "subscription"}
                    title={p.type === "subscription" ? "更新" : "仅订阅支持更新"}
                    aria-label="更新"
                  >
                    {busy === `upd-${p.id}` ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
                  </button>
                  <button
                    className="sm ghost danger icon-button"
                    onClick={() => run(`del-${p.id}`, () => api.profilesDelete(p.id))}
                    disabled={!!busy}
                    title="删除"
                    aria-label="删除"
                  >
                    {busy === `del-${p.id}` ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
