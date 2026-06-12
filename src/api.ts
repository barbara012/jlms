import { invoke } from "@tauri-apps/api/core";

export type CoreStatus = {
  running: boolean;
  version: string | null;
  mixed_port: number;
  controller: string;
  mode: string;
  default_group: string;
};

export type ControllerInfo = { controller: string; secret: string };
export type SystemProxyStatus = {
  enabled: boolean;
  host: string;
  port: number;
  services: string[];
  primary_service?: string | null;
  primary_hardware_port?: string | null;
};
export type LatencyDiagnostics = {
  router_ms?: number | null;
  dns_ms?: number | null;
  gateway?: string | null;
  dns_server?: string | null;
  primary_service?: string | null;
};

export type Profile = {
  id: string;
  name: string;
  type: string;
  url?: string;
  updated_at?: number;
};

export type ProfilesIndex = { active: string | null; profiles: Profile[] };

export type ProxyNode = {
  name: string;
  type: string;
  now?: string;
  all?: string[];
  udp?: boolean;
  history?: { time: string; delay: number }[];
};

export type ProxiesResponse = { proxies: Record<string, ProxyNode> };

export const api = {
  coreStatus: () => invoke<CoreStatus>("core_status"),
  coreStart: () => invoke<void>("core_start"),
  coreStop: () => invoke<void>("core_stop"),
  coreRestart: () => invoke<void>("core_restart"),
  controllerInfo: () => invoke<ControllerInfo>("controller_info"),
  systemProxyStatus: () => invoke<SystemProxyStatus>("system_proxy_status"),
  systemProxySet: (enabled: boolean) =>
    invoke<SystemProxyStatus>("system_proxy_set", { enabled }),
  latencyDiagnostics: () => invoke<LatencyDiagnostics>("latency_diagnostics"),
  setMode: (mode: string) => invoke<void>("set_mode", { mode }),

  proxiesGet: () => invoke<ProxiesResponse>("proxies_get"),
  proxySelect: (group: string, name: string) =>
    invoke<void>("proxy_select", { group, name }),
  proxyDelay: (name: string) => invoke<number>("proxy_delay", { name }),
  proxyDelayMany: (names: string[], requestId?: string) =>
    invoke<Record<string, number | null>>("proxy_delay_many", { names, requestId: requestId ?? null }),

  profilesList: () => invoke<ProfilesIndex>("profiles_list"),
  profilesImport: (url: string, name?: string) =>
    invoke<Profile>("profiles_import", { url, name: name || null }),
  profilesImportFile: (path: string, name?: string) =>
    invoke<Profile>("profiles_import_file", { path, name: name || null }),
  profilesSelect: (id: string) => invoke<void>("profiles_select", { id }),
  profilesUpdate: (id: string) => invoke<Profile>("profiles_update", { id }),
  profilesDelete: (id: string) => invoke<void>("profiles_delete", { id }),
};
