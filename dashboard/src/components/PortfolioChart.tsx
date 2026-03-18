import { useEffect, useRef, useState } from "react";
import { createChart, type IChartApi, type ISeriesApi, ColorType, AreaSeries } from "lightweight-charts";

interface PortfolioChartProps {
  nav: number;
}

interface NavPoint {
  time: number;
  value: number;
}

// Generate initial mock data points for the chart
function generateMockHistory(currentNav: number): NavPoint[] {
  const points: NavPoint[] = [];
  const now = Math.floor(Date.now() / 1000);
  const numPoints = 60;
  const intervalSec = 60; // 1 minute intervals

  let value = currentNav * 0.97; // start slightly lower
  for (let i = 0; i < numPoints; i++) {
    const noise = (Math.random() - 0.48) * currentNav * 0.003;
    value = value + noise;
    if (value < currentNav * 0.9) value = currentNav * 0.92;
    if (value > currentNav * 1.1) value = currentNav * 1.08;
    points.push({
      time: now - (numPoints - i) * intervalSec,
      value,
    });
  }

  // Ensure last point matches current NAV
  points.push({ time: now, value: currentNav });
  return points;
}

export function PortfolioChart({ nav }: PortfolioChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<typeof AreaSeries> | null>(null);
  const [history] = useState<NavPoint[]>(() => generateMockHistory(nav));

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 160,
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" },
        textColor: "#3f3f46",
        fontFamily: "'Geist Mono', 'JetBrains Mono', 'SF Mono', monospace",
        fontSize: 9,
      },
      grid: {
        vertLines: { color: "#1c1c1e" },
        horzLines: { color: "#1c1c1e" },
      },
      crosshair: {
        vertLine: { color: "#3f3f46", width: 1, style: 2 },
        horzLine: { color: "#3f3f46", width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: "#1c1c1e",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: "#1c1c1e",
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: false,
      handleScale: false,
    });

    chartRef.current = chart;

    const isPositive = history.length >= 2 && history[history.length - 1].value >= history[0].value;
    const lineColor = isPositive ? "#22c55e" : "#ef4444";
    const topColor = isPositive ? "rgba(34, 197, 94, 0.2)" : "rgba(239, 68, 68, 0.2)";
    const bottomColor = isPositive ? "rgba(34, 197, 94, 0)" : "rgba(239, 68, 68, 0)";

    const series = chart.addSeries(AreaSeries, {
      lineColor,
      topColor,
      bottomColor,
      lineWidth: 1,
    });

    const chartData = history.map((p) => ({
      time: p.time as any,
      value: p.value,
    }));

    series.setData(chartData);
    seriesRef.current = series;
    chart.timeScale().fitContent();

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update with new NAV values
  useEffect(() => {
    if (!seriesRef.current) return;
    const now = Math.floor(Date.now() / 1000);
    seriesRef.current.update({ time: now as any, value: nav });
  }, [nav]);

  return (
    <div className="portfolio-chart-container">
      <div ref={containerRef} style={{ width: "100%", height: 120 }} />
    </div>
  );
}
