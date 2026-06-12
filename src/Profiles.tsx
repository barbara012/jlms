import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Inbox, LoaderCircle, Play, RefreshCw, Trash2 } from "lucide-react";
import { api, type ProfilesIndex } from "./api";

type RenameDraft = {
  id: string;
  name: string;
};

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
  const [renameDraft, setRenameDraft] = useState<RenameDraft | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const renameSelectPendingRef = useRef(false);

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

  useEffect(() => {
    if (!renameDraft) {
      renameSelectPendingRef.current = false;
      return;
    }

    renameSelectPendingRef.current = true;

    const focusAndSelect = () => {
      const input = renameInputRef.current;
      if (!input || document.visibilityState !== "visible") return;

      if (document.activeElement !== input) {
        input.focus({ preventScroll: true });
      }

      try {
        input.select();
        input.setSelectionRange(0, input.value.length);
      } catch {
        /* selection fallback already handled by select() */
      }
      renameSelectPendingRef.current = false;
    };

    let timeoutId: number | null = null;
    const frame = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(focusAndSelect, 0);
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [renameDraft?.id]);

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
    setBusy("import");
    setError(null);
    void api.profilesImport(value)
      .then(async (profile) => {
        setUrl("");
        setRenameDraft({
          id: profile.id,
          name: profile.name,
        });
        await load();
      })
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const submitRename = (overrideName?: string) => {
    if (!renameDraft) return;
    const nextName = (overrideName ?? renameInputRef.current?.value ?? renameDraft.name).trim();
    if (!nextName) return;
    setRenameBusy(true);
    setError(null);
    void api.profilesRename(renameDraft.id, nextName)
      .then(async () => {
        await load();
        setRenameDraft(null);
      })
      .catch((e) => {
        setError(String(e));
      })
      .finally(() => {
        setRenameBusy(false);
      });
  };

  const skipRename = () => {
    if (renameBusy) return;
    setRenameDraft(null);
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
    <>
      <div className="view">
        <section className="page-hero">
          <div>
            <div className="activity-kicker">代理</div>
            <h1 className="activity-title">订阅</h1>
            <p className="page-hero-sub">导入 Clash / mihomo 格式订阅，激活后内核即按其节点与规则运行。</p>
          </div>
        </section>

        <section className="surge-card profile-import-strip">
          <div className="import-row profile-import-row">
            <input
              placeholder="粘贴订阅链接 (https://…)"
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && onImport()}
            />
            <div className="toolbar-actions">
              <button onClick={onImport} disabled={busy === "import" || !url.trim()}>
                {busy === "import" ? "导入中…" : "导入链接"}
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
                        disabled={!!busy || renameBusy}
                        title="启用"
                        aria-label="启用"
                      >
                        {busy === `sel-${p.id}` ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                      </button>
                    )}
                    <button
                      className="sm ghost icon-button"
                      onClick={() => run(`upd-${p.id}`, () => api.profilesUpdate(p.id))}
                      disabled={!!busy || renameBusy || p.type !== "subscription"}
                      title={p.type === "subscription" ? "更新" : "仅订阅支持更新"}
                      aria-label="更新"
                    >
                      {busy === `upd-${p.id}` ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
                    </button>
                    <button
                      className="sm ghost danger icon-button"
                      onClick={() => run(`del-${p.id}`, () => api.profilesDelete(p.id))}
                      disabled={!!busy || renameBusy}
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

      {renameDraft && (
        <div className="profile-name-panel-backdrop">
          <section
            className="profile-name-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="profile-rename-title"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="profile-name-panel-head">
              <div className="profile-rename-title" id="profile-rename-title">
                配置名
              </div>
            </div>
            <div className="profile-rename-editor">
              <input
                key={renameDraft.id}
                id="profile-rename-input"
                ref={renameInputRef}
                autoFocus
                defaultValue={renameDraft.name}
                onFocus={(e) => {
                  if (!renameSelectPendingRef.current) return;
                  e.currentTarget.select();
                  try {
                    e.currentTarget.setSelectionRange(0, e.currentTarget.value.length);
                  } catch {
                    /* selection fallback already handled by select() */
                  }
                  renameSelectPendingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    submitRename();
                  }
                  if (e.key === "Escape" && !renameBusy) {
                    skipRename();
                  }
                }}
                placeholder="输入配置名称"
              />
            </div>
            <div className="profile-rename-row">
              <button className="primary" onClick={() => submitRename()} disabled={renameBusy}>
                {renameBusy ? "保存中…" : "保存"}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
