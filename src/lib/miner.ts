import { invoke } from "@tauri-apps/api/core";

// ── Tauri command wrappers ────────────────────────────────────────────────────

export function startMiner(address: string, threads: number): Promise<void> {
  return invoke("start_miner", { address, threads });
}

export function stopMiner(): Promise<void> {
  return invoke("stop_miner");
}

/** Returns the OS PID if the miner process is running, null if stopped/crashed. */
export function getMinerPid(): Promise<number | null> {
  return invoke("get_miner_pid");
}

// ── Local RPC helpers ─────────────────────────────────────────────────────────

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

// Calls the local miner node RPC. URL is hardcoded in Rust (127.0.0.1:8546).
async function callMinerRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const data = await invoke<RpcResponse>("miner_rpc_call", { method, params });
  if (data.error) throw new Error(`RPC ${data.error.code}: ${data.error.message}`);
  return data.result ?? null;
}

// ── Status polling ────────────────────────────────────────────────────────────

export type MinerStatus = "stopped" | "starting" | "syncing" | "mining" | "crashed";

export interface SyncInfo {
  current: number;
  highest: number;
}

export interface MinerPollResult {
  status: MinerStatus;
  syncInfo?: SyncInfo;       // only set when delta > 100 — triggers progress bar
  catchupBlocks?: number;    // set when delta <= 100 — fast checkpoint catchup
  hashrate?: number;         // raw H/s from eth_hashrate
  blockNumber?: number;
  peerCount?: number;
}

export function formatHashrate(hps: number): string {
  if (hps === 0) return "0 H/s";
  if (hps < 1_000) return `${hps} H/s`;
  if (hps < 1_000_000) return `${(hps / 1_000).toFixed(1)} kH/s`;
  return `${(hps / 1_000_000).toFixed(2)} MH/s`;
}

export function getSyncCache(): Promise<{ current: number; highest: number } | null> {
  return invoke<{ current: number; highest: number } | null>("get_sync_cache").catch(() => null);
}

function saveSyncCache(current: number, highest: number): void {
  invoke("save_sync_cache", { current, highest }).catch(() => {});
}

/** Read last 8 KB of the miner's stderr log. */
async function getMinerLogTail(): Promise<string> {
  return invoke<string>("get_miner_log_tail", { bytes: 8192 }).catch(() => "");
}

/**
 * Derive hashrate (H/s) from sealed-block entries in go-ethereum stderr log.
 *
 * This binary doesn't implement eth_hashrate and doesn't print a hashrate line.
 * What it does log is:
 *   INFO [MM-DD|HH:MM:SS.mmm] Successfully sealed new RandomX block  ... difficulty=35,729,236
 *
 * hashrate = difficulty / solve_time, so over multiple seals:
 *   hashrate ≈ (N-1 × avg_difficulty) / total_span_seconds
 */
export function parseHashrateFromLog(log: string): number {
  type Entry = { secs: number; difficulty: number };
  const entries: Entry[] = [];

  const re = /\[\d{2}-\d{2}\|(\d{2}):(\d{2}):(\d{2})\.\d+\]\s+Successfully sealed new RandomX block[^\n]*difficulty=([\d,]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log)) !== null) {
    const secs = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
    const difficulty = parseInt(m[4].replace(/,/g, ""), 10);
    entries.push({ secs, difficulty });
  }

  if (entries.length === 0) return 0;

  const avgDiff = entries.reduce((sum, e) => sum + e.difficulty, 0) / entries.length;

  if (entries.length === 1) {
    return Math.round(avgDiff / 30);
  }

  let spanSecs = entries[entries.length - 1].secs - entries[0].secs;
  if (spanSecs < 0) spanSecs += 86400; // midnight rollover
  if (spanSecs === 0) return Math.round(avgDiff / 10);

  return Math.round(((entries.length - 1) * avgDiff) / spanSecs);
}

const RPC_FAIL = Symbol("RPC_FAIL");

/**
 * Poll the miner's status by:
 * 1. Checking the OS process is alive via get_miner_pid
 * 2. Querying the miner's local HTTP RPC (127.0.0.1:8546)
 *
 * Call this repeatedly (every ~3s) while running=true.
 */
export async function pollMinerStatus(isRunning: boolean): Promise<MinerPollResult> {
  if (!isRunning) return { status: "stopped" };

  const pid = await getMinerPid();
  if (pid === null) return { status: "crashed" };

  const syncResult = await callMinerRpc("eth_syncing", []).catch(() => RPC_FAIL);
  if (syncResult === RPC_FAIL) return { status: "starting" };

  const [blockNum, peerHex, logTail] = await Promise.all([
    callMinerRpc("eth_blockNumber", []).catch(() => "0x0"),
    callMinerRpc("net_peerCount", []).catch(() => "0x0"),
    getMinerLogTail(),
  ]);

  const hashrate = parseHashrateFromLog(logTail);
  const peerCount = parseInt(peerHex as string, 16);

  if (syncResult !== false && syncResult !== null && typeof syncResult === "object") {
    const s = syncResult as { currentBlock: string; highestBlock: string };
    const current = parseInt(s.currentBlock, 16);
    const highest = parseInt(s.highestBlock, 16);
    const delta = highest - current;

    if (current > 0 && highest > 0) saveSyncCache(current, highest);

    return {
      status: "syncing",
      syncInfo: delta > 100 ? { current, highest } : undefined,
      catchupBlocks: delta > 0 ? delta : undefined,
      blockNumber: parseInt(blockNum as string, 16),
      peerCount,
    };
  }

  return {
    status: "mining",
    hashrate,
    blockNumber: parseInt(blockNum as string, 16),
    peerCount,
  };
}
