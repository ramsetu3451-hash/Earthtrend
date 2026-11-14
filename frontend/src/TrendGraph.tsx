import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, Maximize2, X } from "lucide-react";

declare global {
  interface Window {
    Chart: any;
    MerobimanChartRuntime: any;
  }
}
type Observation = { year: number; value: number };
type Model = {
  slopePerDecade: number;
  intercept: number;
  ciLow: number;
  ciHigh: number;
};
type Props = { region: string; series: Observation[]; model: Model };

function Plot({ region, series, model, expanded = false }: Props & { expanded?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const instance = useRef<any>(null);
  const id = useId().replace(/:/g, "");
  const [failed, setFailed] = useState(false);
  const [yearIndex, setYearIndex] = useState(0);
  const fitted = series.map(p => model.intercept + model.slopePerDecade * p.year / 10);

  useEffect(() => {
    setYearIndex(0);
    setFailed(false);
    const { Chart, MerobimanChartRuntime: runtime } = window;
    if (!Chart || !runtime || !canvas.current) { setFailed(true); return; }
    // Same annual series and OLS coefficients as the Go analysis and CSV export.
    // No smoothing, extrapolation, or fabricated confidence/prediction band.
    const prediction = series.map(p => model.intercept + model.slopePerDecade * p.year / 10);
    const values = [...series.map(p => p.value), ...prediction];
    const range = runtime.axisRange(Math.min(0, ...values), Math.max(0, ...values), { target: 5 });
    const color = (name: string, fallback: string) => runtime.cssVar(name) || fallback;
    const blue = color("--chart-blue", "#7fb4ec");
    const purple = color("--chart-purple", "#bf8eda");
    const muted = color("--muted", "#a4b4b9");
    const grid = color("--chart-grid", "rgba(255,255,255,.14)");
    const line = (label: string, data: number[], hue: string) => ({
      label, valueKind: "number", data, borderColor: hue, backgroundColor: hue,
      borderWidth: 2, tension: 0, pointRadius: expanded ? 3 : 2,
      pointHoverRadius: 5, pointBackgroundColor: hue, pointBorderWidth: 0,
      fill: false, spanGaps: false, clip: 8,
    });
    const chart = new Chart(canvas.current, {
      type: "line",
      data: { labels: series.map(p => String(p.year)), datasets: [
        line("Annual anomaly", series.map(p => p.value), blue),
        line("OLS fitted anomaly", prediction, purple),
      ] },
      plugins: [runtime.chartJs.crosshair, runtime.chartJs.createAudit({ valueAxis: "y", valueKind: "number" })],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        layout: { padding: 0 }, interaction: { mode: "index", intersect: false, axis: "x" },
        plugins: { legend: { display: false }, tooltip: {
          enabled: false, external: runtime.chartJs.createTooltip((year: string) => year, "Temperature anomaly in °C vs. 1951–1980"),
        } },
        scales: {
          x: { grid: { display: false }, ticks: { color: muted, autoSkip: true, maxTicksLimit: expanded ? 8 : 4, maxRotation: 0, font: { size: 12 } } },
          y: { min: range.min, max: range.max, ticks: {
            color: muted, stepSize: range.step, autoSkip: false, font: { size: 12 },
            callback: (value: number) => runtime.formatValue(value, "number"),
          }, grid: { color: grid } },
        },
      },
    });
    instance.current = chart;
    runtime.chartJs.stabilize(chart);
    return () => { chart.destroy(); instance.current = null; };
  }, [series, model, expanded]);

  const point = series[Math.min(yearIndex, series.length - 1)];
  return <div className={`trend-graph ${expanded ? "expanded" : ""}`}>
    <p className="trend-graph-context">°C anomaly vs. 1951–1980 · {series[0].year}–{series[series.length - 1].year}</p>
    <div className="legend" data-chart-id={id}>
      <span><i className="key-line observed" />Annual anomaly</span>
      <span><i className="key-line fitted" />OLS fitted anomaly</span>
    </div>
    <p className="sr-only">{region}: {series.length} annual observations. First anomaly {series[0].value.toFixed(3)} °C; last anomaly {series[series.length - 1].value.toFixed(3)} °C. The fitted line is a model, not additional observations. Exact values follow in the accessible table.</p>
    {failed ? <p role="alert">Graph unavailable. The annual data table and CSV remain available.</p> :
      <div className="chart-wrap" style={{ height: expanded ? 340 : 210 }}>
        <canvas id={id} ref={canvas} data-series-legend="true" role="img" aria-label={`${region} annual temperature anomalies, ${series[0].year}–${series[series.length - 1].year}; first ${series[0].value.toFixed(3)} and last ${series[series.length - 1].value.toFixed(3)} degrees Celsius, with OLS model fit. Exact values in the following table.`} />
        <div className="chart-tooltip" role="tooltip" aria-hidden="true" />
      </div>}
    <table className="sr-only">
      <caption>{region}: annual observations and OLS fitted values in °C relative to 1951–1980</caption>
      <thead><tr><th>Year</th><th>Annual anomaly</th><th>OLS fitted anomaly</th></tr></thead>
      <tbody>{series.map((p, i) => <tr key={p.year}><th>{p.year}</th>
        <td data-observation-key={String(p.year)} data-series-key="Annual anomaly" data-raw-value={p.value} data-value-kind="number">{p.value.toFixed(3)}</td>
        <td data-observation-key={String(p.year)} data-series-key="OLS fitted anomaly" data-raw-value={fitted[i]} data-value-kind="number">{fitted[i].toFixed(3)}</td>
      </tr>)}</tbody>
    </table>
    {expanded && <div className="graph-keyboard">
      <label htmlFor={`${id}-year`}>Inspect year · {point.year}</label>
      <input id={`${id}-year`} aria-label="Inspect graph year" type="range" min={0} max={series.length - 1} value={yearIndex}
        onChange={e => setYearIndex(Number(e.target.value))} />
      <p aria-live="polite">{point.year}: observed <strong>{point.value.toFixed(3)} °C</strong>; fitted <strong>{fitted[Math.min(yearIndex, series.length - 1)].toFixed(3)} °C</strong>.</p>
    </div>}
  </div>;
}

export default function TrendGraph(props: Props) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; opener.current?.focus(); };
  }, [open]);
  const save = () => {
    const cv = dialog.current?.querySelector("canvas");
    if (!cv) return;
    const image = document.createElement("canvas");
    const scale = Math.max(1, window.devicePixelRatio || 1);
    const padding = 20 * scale;
    const header = 100 * scale;
    image.width = cv.width + padding * 2;
    image.height = cv.height + header + padding;
    const ctx = image.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#152329";
    ctx.fillRect(0, 0, image.width, image.height);
    ctx.fillStyle = "#e9f0ed";
    ctx.font = `${18 * scale}px Arial`;
    ctx.fillText(`${props.region} temperature trend`, padding, 28 * scale, image.width - padding * 2);
    ctx.font = `${13 * scale}px Arial`;
    ctx.fillText(`${props.series[0].year}–${props.series[props.series.length - 1].year} · °C anomaly vs. 1951–1980`, padding, 50 * scale, image.width - padding * 2);
    ctx.fillStyle = "#7fb4ec";
    ctx.fillText("Annual anomaly", padding, 76 * scale);
    ctx.fillStyle = "#bf8eda";
    ctx.fillText("OLS fitted anomaly", padding + 132 * scale, 76 * scale);
    ctx.drawImage(cv, padding, header);
    const a = document.createElement("a");
    a.download = `merobiman-${props.region.replace(/[^a-z0-9]/gi, "-")}-${props.series[0].year}-${props.series[props.series.length - 1].year}-trend.png`;
    a.href = image.toDataURL("image/png"); a.click();
  };
  return <section className="trend-graph-section" aria-label="Regional temperature trend graph">
    <div className="trend-graph-heading"><h3>4 · Visualize the trend</h3>
      <button ref={opener} className="text-button" onClick={() => setOpen(true)} aria-label="Expand temperature trend graph"><Maximize2 size={16} />Expand</button>
    </div>
    <Plot {...props} />
    <p className="trend-graph-note">The fitted line summarizes change; annual variability is retained. Slope uncertainty is reported above, not as a prediction band.</p>
    {open && <dialog ref={dialog} className="trend-graph-dialog" aria-labelledby="trend-graph-title"
      onCancel={e => { e.preventDefault(); setOpen(false); }}
      onClick={e => { if (e.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) setOpen(false); } }}>
      <div className="trend-dialog-heading"><div><span className="eyebrow">REGIONAL ANALYSIS</span><h2 id="trend-graph-title">{props.region} temperature trend</h2></div>
        <button className="icon-button" aria-label="Close trend graph" onClick={() => setOpen(false)}><X size={20} /></button>
      </div>
      <Plot {...props} expanded />
      <p className="trend-graph-note">OLS slope: {props.model.slopePerDecade.toFixed(3)} °C/decade · 95% HAC slope interval: {props.model.ciLow.toFixed(3)} to {props.model.ciHigh.toFixed(3)} °C/decade. Detecting a trend does not establish its cause.</p>
      <button className="button subtle" onClick={save}><ArrowDownToLine size={16} />Download graph PNG</button>
    </dialog>}
  </section>;
}