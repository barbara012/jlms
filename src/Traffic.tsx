import { useEffect, useMemo, useState } from "react";
import { openStream, type TrafficSample } from "./ws";

type TrafficPoint = TrafficSample & {
  ts: number;
};

const MAX_POINTS = 60;
const CHART_WIDTH = 760;
const CHART_HEIGHT = 240;

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

function fmtSpeed(n: number) {
  const { v, u } = fmtBytes(n);
  return `${v} ${u}/s`;
}

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString();
}

function avg(list: number[]) {
  if (list.length === 0) return 0;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function buildPath(points: number[], maxValue: number) {
  if (points.length === 0) return "";
  const stepX = points.length > 1 ? CHART_WIDTH / (points.length - 1) : 0;
  return points
    .map((value, index) => {
      const x = index * stepX;
      const y = CHART_HEIGHT - (value / maxValue) * CHART_HEIGHT;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildArea(path: string) {
  if (!path) return "";
  return `${path} L ${CHART_WIDTH} ${CHART_HEIGHT} L 0 ${CHART_HEIGHT} Z`;
}

export function Traffic() {
  const [current, setCurrent] = useState<TrafficSample>({ up: 0, down: 0 });
  const [history, setHistory] = useState<TrafficPoint[]>([]);

  useEffect(() => {
    let stop = () => {};
    let disposed = false;
    openStream<TrafficSample>("traffic", (sample) => {
      const point = { ...sample, ts: Date.now() };
      setCurrent(sample);
      setHistory((prev) => [...prev, point].slice(-MAX_POINTS));
    }, { throttleMs: 250 }).then((f) => {
      if (disposed) {
        f();
        return;
      }
      stop = f;
    });
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  const downSeries = useMemo(() => history.map((item) => item.down), [history]);
  const upSeries = useMemo(() => history.map((item) => item.up), [history]);
  const peakDown = useMemo(() => Math.max(0, ...downSeries), [downSeries]);
  const peakUp = useMemo(() => Math.max(0, ...upSeries), [upSeries]);
  const avgDown = useMemo(() => avg(downSeries), [downSeries]);
  const avgUp = useMemo(() => avg(upSeries), [upSeries]);
  const maxValue = Math.max(1, peakDown, peakUp);
  const downPath = buildPath(downSeries, maxValue);
  const upPath = buildPath(upSeries, maxValue);
  const downArea = buildArea(downPath);
  const upArea = buildArea(upPath);

  const recent = useMemo(() => [...history].reverse().slice(0, 8), [history]);
  const yLabels = useMemo(() => [1, 0.75, 0.5, 0.25, 0].map((n) => fmtSpeed(maxValue * n)), [maxValue]);
  const strongest = Math.max(current.down, current.up);

  return (
    <div className="view">
      <section className="page-hero">
        <div>
          <div className="activity-kicker">Clients</div>
          <h1 className="activity-title">Device</h1>
          <p className="page-hero-sub">查看最近一分钟的实时上下行变化、峰值和最近采样记录。</p>
        </div>
      </section>

      <div className="surge-grid surge-grid-traffic">
        <section className="surge-card surge-request-summary">
          <div className="surge-card-label">Current Download</div>
          <div className="surge-speed-value">
            {fmtBytes(current.down).v}
            <small>{fmtBytes(current.down).u}/s</small>
          </div>
          <div className="surge-speed-line download" />
        </section>

        <section className="surge-card surge-request-summary">
          <div className="surge-card-label">Current Upload</div>
          <div className="surge-speed-value">
            {fmtBytes(current.up).v}
            <small>{fmtBytes(current.up).u}/s</small>
          </div>
          <div className="surge-speed-line upload" />
        </section>

        <section className="surge-card surge-request-summary">
          <div className="surge-card-label">Peak</div>
          <div className="surge-speed-value">
            {fmtBytes(Math.max(peakDown, peakUp)).v}
            <small>{fmtBytes(Math.max(peakDown, peakUp)).u}/s</small>
          </div>
          <div className="surge-card-subtle">当前最强方向 {strongest === current.down ? "Download" : "Upload"}</div>
        </section>
      </div>

      <section className="traffic-panel surge-traffic-shell">
        <div className="traffic-chart-head">
          <div>
            <div className="surge-card-label">Traffic</div>
            <div className="traffic-caption">保留最近 {MAX_POINTS} 个采样点，按接收顺序实时滚动。</div>
          </div>
          <div className="traffic-legend">
            <span className="legend-item down">下载</span>
            <span className="legend-item up">上传</span>
          </div>
        </div>

        <div className="traffic-chart-wrap">
          <div className="traffic-y-axis">
            {yLabels.map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>
          <div className="traffic-chart">
            {history.length === 0 ? (
              <div className="traffic-empty">等待实时流量数据…</div>
            ) : (
              <svg
                viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
                className="traffic-svg"
                preserveAspectRatio="none"
              >
                {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
                  const y = CHART_HEIGHT - tick * CHART_HEIGHT;
                  return (
                    <line
                      key={tick}
                      x1="0"
                      y1={y}
                      x2={CHART_WIDTH}
                      y2={y}
                      className="traffic-grid-line"
                    />
                  );
                })}
                <path d={downArea} className="traffic-area down" />
                <path d={upArea} className="traffic-area up" />
                <path d={downPath} className="traffic-line down" />
                <path d={upPath} className="traffic-line up" />
              </svg>
            )}
          </div>
        </div>
      </section>

      <div className="traffic-split">
        <section className="surge-card traffic-stat-card">
          <div className="surge-card-label">Statistics</div>
          <div className="traffic-stats">
            <Stat label="平均下载" value={fmtSpeed(avgDown)} />
            <Stat label="平均上传" value={fmtSpeed(avgUp)} />
            <Stat label="采样窗口" value={`${history.length} / ${MAX_POINTS}`} />
            <Stat label="最近峰值" value={`${fmtSpeed(Math.max(peakDown, peakUp))}`} />
          </div>
        </section>

        <section className="surge-card traffic-sample-card">
          <div className="surge-card-label">Recent Samples</div>
          {recent.length === 0 ? (
            <div className="empty">还没有采样数据。</div>
          ) : (
            <div className="sample-list">
              {recent.map((point) => (
                <div key={point.ts} className="sample-row">
                  <span className="sample-time">{fmtTime(point.ts)}</span>
                  <span className="sample-value down">下 {fmtSpeed(point.down)}</span>
                  <span className="sample-value up">上 {fmtSpeed(point.up)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-item">
      <span className="label">{label}</span>
      <span className="value">{value}</span>
    </div>
  );
}
