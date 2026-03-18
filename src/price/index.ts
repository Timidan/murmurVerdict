import { WebSocket } from "ws";
import type { PriceBar, PriceFeedState } from "../types/index.js";

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws/ethusdt@kline_1m";
const MAX_BARS_1M = 10;
const MAX_BARS_5M = 5;

let ws: WebSocket | null = null;
let bars1m: PriceBar[] = [];
let currentBar: PriceBar | null = null;
let currentPrice = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function parseKline(data: any): PriceBar {
  const k = data.k;
  return {
    open: parseFloat(k.o),
    high: parseFloat(k.h),
    low: parseFloat(k.l),
    close: parseFloat(k.c),
    volume: parseFloat(k.v),
    openTime: k.t,
    closeTime: k.T,
  };
}

function build5mBars(m1: PriceBar[]): PriceBar[] {
  if (m1.length < 5) return [];
  const result: PriceBar[] = [];
  const aligned = m1.slice(-(m1.length - (m1.length % 5) || m1.length));
  for (let i = 0; i < aligned.length; i += 5) {
    const chunk = aligned.slice(i, i + 5);
    if (chunk.length < 5) break;
    result.push({
      open: chunk[0]!.open,
      high: Math.max(...chunk.map(b => b.high)),
      low: Math.min(...chunk.map(b => b.low)),
      close: chunk[chunk.length - 1]!.close,
      volume: chunk.reduce((s, b) => s + b.volume, 0),
      openTime: chunk[0]!.openTime,
      closeTime: chunk[chunk.length - 1]!.closeTime,
    });
  }
  return result.slice(-MAX_BARS_5M);
}

function connect() {
  if (ws) {
    try { ws.close(); } catch {}
  }

  ws = new WebSocket(BINANCE_WS_URL);

  ws.on("open", () => {
    console.log("[Price] Binance ETH/USDT WebSocket connected");
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.e !== "kline") return;

      const bar = parseKline(data);
      currentPrice = bar.close;

      if (data.k.x) {
        // Kline closed — finalize bar
        bars1m.push(bar);
        if (bars1m.length > MAX_BARS_1M) bars1m = bars1m.slice(-MAX_BARS_1M);
        currentBar = null;
      } else {
        // Kline still forming
        currentBar = bar;
      }
    } catch (err) {
      console.warn("[Price] Failed to parse Binance message:", (err as Error).message);
    }
  });

  ws.on("close", () => {
    console.warn("[Price] Binance WS disconnected — reconnecting in 5s");
    reconnectTimer = setTimeout(connect, 5000);
  });

  ws.on("error", (err: Error) => {
    console.error("[Price] Binance WS error:", err.message);
  });
}

export function startPriceFeed(): void {
  connect();
}

export function stopPriceFeed(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
}

export function getPriceState(): PriceFeedState {
  const allBars = currentBar ? [...bars1m, currentBar] : [...bars1m];
  const bars5m = build5mBars(allBars);

  let momentum1m = 0;
  if (allBars.length >= 2) {
    const prev = allBars[allBars.length - 2]!.close;
    momentum1m = prev > 0 ? ((currentPrice - prev) / prev) * 100 : 0;
  }

  let momentum5m = 0;
  if (allBars.length >= 5) {
    const prev5 = allBars[allBars.length - 5]!.close;
    momentum5m = prev5 > 0 ? ((currentPrice - prev5) / prev5) * 100 : 0;
  }

  const recent5 = allBars.slice(-5);
  const high5m = recent5.length > 0 ? Math.max(...recent5.map(b => b.high)) : currentPrice;
  const low5m = recent5.length > 0 ? Math.min(...recent5.map(b => b.low)) : currentPrice;

  return {
    currentPrice,
    bars1m: allBars.slice(-MAX_BARS_1M),
    bars5m,
    momentum1m,
    momentum5m,
    high5m,
    low5m,
    updatedAt: new Date().toISOString(),
  };
}

export function hasPriceData(): boolean {
  return currentPrice > 0;
}
