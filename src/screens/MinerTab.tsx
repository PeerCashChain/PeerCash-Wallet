import { useState, useEffect, useRef } from "react";
import {
  startMiner,
  stopMiner,
  pollMinerStatus,
  getSyncCache,
  getMinerMode,
  formatHashrate,
  type MinerStatus,
  type MinerPollResult,
  type MinerMode,
} from "../lib/miner";
import type { NetworkInfo } from "../config";

interface Props {
  address: string;
  net: NetworkInfo;
}

const LABEL = "block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5";

function StatusDot({ status }: { status: MinerStatus }) {
  const cls = {
    stopped: "bg-zinc-600",
    starting: "bg-yellow-400 animate-pulse",
    syncing: "bg-blue-400 animate-pulse",
    mining: "bg-peer",
    crashed: "bg-red-500",
  }[status];
  return <div className={`w-3 h-3 rounded-full ${cls}`} />;
}

function statusLabel(s: MinerStatus) {
  return {
    stopped: "Not Mining",
    starting: "Starting Node…",
    syncing: "Syncing",
    mining: "Mining",
    crashed: "Crashed",
  }[s];
}

function statusSubtext(poll: MinerPollResult, elapsed: number, symbol: string): string {
  const t = elapsed > 0 ? ` (${elapsed}s)` : "";
  switch (poll.status) {
    case "stopped":  return `Start to begin earning ${symbol}`;
    case "starting": return `Waiting for the local RPC to come online…${t}`;
    case "syncing":
      if (poll.syncInfo)       return poll.syncInfo.current === 0
        ? "Downloading blockchain history from peers — mining begins when caught up"
        : "Replaying blocks from local checkpoint — mining resumes shortly";
      if (poll.catchupBlocks)  return `Replaying ${poll.catchupBlocks.toLocaleString()} local blocks from last checkpoint`;
      return `Searching for network peers via bootnode…${t}`;
    case "mining":   return `Rewards go to your wallet address`;
    case "crashed":  return "The node process exited unexpectedly";
  }
}

function formatEta(remainingBlocks: number, blocksPerSec: number): string {
  if (blocksPerSec <= 0) return "";
  const secs = Math.ceil(remainingBlocks / blocksPerSec);
  if (secs < 90)  return `~${secs}s`;
  if (secs < 3600) return `~${Math.ceil(secs / 60)}m`;
  return `~${(secs / 3600).toFixed(1)}h`;
}

function SyncProgress({
  current, highest, rate,
}: { current: number; highest: number; rate: number }) {
  const remaining = highest - current;
  const pct = highest > 0 ? Math.min(100, Math.round((current / highest) * 100)) : 0;
  const eta = formatEta(remaining, rate);

  return (
    <div className="w-full space-y-1.5">
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="h-full bg-blue-400 rounded-full transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-xs text-zinc-500 tabular-nums">
        <span>
          {current.toLocaleString()} → {highest.toLocaleString()}
          {rate > 0 && <span className="text-zinc-600"> · {rate.toLocaleString()} blk/s</span>}
        </span>
        <span>
          {remaining.toLocaleString()} left{eta && <span> · {eta}</span>}
        </span>
      </div>
    </div>
  );
}

export default function MinerTab({ address, net }: Props) {
  const [running, setRunning] = useState(false);
  const [poll, setPoll] = useState<MinerPollResult>({ status: "stopped" });
  // Persisted so the selection survives tab switches (this component unmounts when
  // the wallet tab is shown) and app restarts, and reflects the running miner.
  const [threads, setThreads] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem("peercash.minerThreads") ?? "", 10);
    return Number.isFinite(saved) && saved >= 1 && saved <= 16 ? saved : 2;
  });
  const [error, setError] = useState("");
  const [toggling, setToggling] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [syncRate, setSyncRate] = useState(0); // blocks/sec
  const [syncCache, setSyncCache] = useState<{ current: number; highest: number } | null>(null);
  const [mode, setMode] = useState<MinerMode | null>(null);
  // When the node first reached the mining phase — RandomX dataset build starts here.
  const [miningStartedAt, setMiningStartedAt] = useState<number | null>(null);

  const runningRef = useRef(running);
  const prevSyncRef = useRef<{ block: number; ts: number } | null>(null);

  useEffect(() => { runningRef.current = running; }, [running]);

  // Persist the thread selection across remounts/restarts.
  useEffect(() => { localStorage.setItem("peercash.minerThreads", String(threads)); }, [threads]);

  // Calculate sync rate whenever currentBlock advances
  useEffect(() => {
    if (poll.status !== "syncing" || !poll.syncInfo) {
      prevSyncRef.current = null;
      setSyncRate(0);
      return;
    }
    const now = Date.now();
    const prev = prevSyncRef.current;
    if (prev && now > prev.ts) {
      const blockDelta = poll.syncInfo.current - prev.block;
      const secDelta = (now - prev.ts) / 1000;
      if (blockDelta > 0 && secDelta > 0) {
        setSyncRate(Math.round(blockDelta / secDelta));
      }
    }
    prevSyncRef.current = { block: poll.syncInfo.current, ts: now };
  }, [poll]);

  // Stamp when mining begins (sync done → sealer starts), so we can show the
  // RandomX dataset-build window. Clear it whenever we leave the mining phase.
  useEffect(() => {
    if (poll.status === "mining") {
      setMiningStartedAt((prev) => prev ?? Date.now());
    } else {
      setMiningStartedAt(null);
    }
  }, [poll.status]);

  // Elapsed-seconds ticker — shown while connecting/starting so the user knows it's alive
  useEffect(() => {
    if (!running || !startedAt) { setElapsed(0); return; }
    if (poll.status === "mining") return; // no need once mining
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running, startedAt, poll.status]);

  // On mount: load cached sync progress + check if miner is already running
  useEffect(() => {
    getSyncCache().then((c) => { if (c) setSyncCache(c); });
    pollMinerStatus(true).then((result) => {
      if (result.status !== "crashed") {
        setRunning(true);
        setPoll(result);
        getMinerMode().then((m) => { if (m) setMode(m); });
        if (result.status === "mining") setMiningStartedAt(Date.now());
      }
    }).catch(() => {/* not running */});
  }, []);

  // Polling loop — runs every 3s while the node is supposed to be running
  useEffect(() => {
    if (!running) return;

    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      const result = await pollMinerStatus(runningRef.current);
      if (!cancelled) {
        setPoll(result);
        if (result.status === "crashed") {
          setRunning(false);
          setError("The node process exited unexpectedly. Check that the binary path is correct and try again.");
        }
      }
    }

    tick();
    const id = setInterval(tick, 3_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [running]);

  async function handleStart() {
    setError("");
    setToggling(true);
    try {
      const m = await startMiner(address, threads);
      setMode(m);
      setRunning(true);
      setStartedAt(Date.now());
      setPoll({ status: "starting" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start miner");
    } finally {
      setToggling(false);
    }
  }

  async function handleStop() {
    setError("");
    setToggling(true);
    try {
      await stopMiner();
    } catch {
      // Best-effort — update UI regardless
    } finally {
      setRunning(false);
      setStartedAt(null);
      setPoll({ status: "stopped" });
      setMode(null);
      setMiningStartedAt(null);
      setToggling(false);
    }
  }

  const isStopped = poll.status === "stopped" || poll.status === "crashed";
  // In fast mode the sealer builds a ~2.3 GiB dataset (~30–90s) before any hashing;
  // hashrate reads 0 until it's ready. Show a distinct "preparing" state for ~90s.
  const preparing =
    poll.status === "mining" &&
    (mode?.fullMem ?? false) &&
    (poll.hashrate ?? 0) === 0 &&
    miningStartedAt !== null &&
    Date.now() - miningStartedAt < 90_000;
  const isMining  = poll.status === "mining" && !preparing;

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col select-none">
      <header className="flex items-center px-6 py-4 border-b border-zinc-800/60">
        <div className="w-16" />
        <div className="flex items-center gap-2.5 mx-auto">
          <img src="/logo.jpg" alt="PeerCash" className="w-7 h-7 rounded-full" />
          <span className="font-semibold tracking-tight">PeerCash</span>
        </div>
        <div className="w-16" />
      </header>

      <main className="flex-1 px-6 py-6 w-full max-w-md mx-auto space-y-4">

        {/* ── Status card ── */}
        <div className={`bg-zinc-900 border rounded-xl p-6 space-y-4 transition-colors ${
          isMining
            ? "border-peer/40"
            : poll.status === "crashed"
              ? "border-red-800/60"
              : "border-zinc-800"
        }`}>
          {/* Header row */}
          <div className="flex items-center gap-3">
            {preparing
              ? <div className="w-3 h-3 rounded-full bg-amber-400 animate-pulse" />
              : <StatusDot status={poll.status} />}
            <span className={`text-lg font-semibold ${
              preparing ? "text-amber-400"
                : isMining ? "text-peer"
                : poll.status === "crashed" ? "text-red-400"
                : "text-white"
            }`}>
              {preparing ? "Preparing mining dataset…" : statusLabel(poll.status)}
            </span>
          </div>

          <p className="text-sm text-zinc-500">
            {preparing
              ? "Building the RandomX dataset (~30–90s). Hashing begins once it's ready."
              : statusSubtext(poll, elapsed, net.currencySymbol)}
          </p>

          {/* RandomX mode badge — shown whenever the miner is running */}
          {mode && !isStopped && (
            <div
              className="inline-flex items-center gap-1.5 text-xs cursor-help w-fit"
              title={
                mode.fullMem
                  ? `Fast mode: RandomX uses a full ~2.3 GB dataset for much faster hashing. Enabled because ${mode.freeMemMb.toLocaleString()} MB RAM was free at start.`
                  : `Light mode: RandomX uses ~256 MB per thread. Fast mode needs ~2.3 GB free RAM; only ${mode.freeMemMb.toLocaleString()} MB was free at start.`
              }
            >
              <span className={`w-1.5 h-1.5 rounded-full ${mode.fullMem ? "bg-peer" : "bg-zinc-500"}`} />
              <span className={mode.fullMem ? "text-peer" : "text-zinc-400"}>
                {mode.fullMem ? "Fast mode" : "Light mode, low memory"}
              </span>
            </div>
          )}

          {/* Last-known sync progress — shown when stopped and cache exists */}
          {isStopped && syncCache && syncCache.highest > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-zinc-600">
                Last synced: block {syncCache.current.toLocaleString()} of {syncCache.highest.toLocaleString()}
              </p>
              <SyncProgress current={syncCache.current} highest={syncCache.highest} rate={0} />
            </div>
          )}

          {/* Peer count — shown whenever the node is running */}
          {(poll.status === "syncing" || poll.status === "mining") && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <div className={`w-1.5 h-1.5 rounded-full ${
                (poll.peerCount ?? 0) > 0 ? "bg-green-400" : "bg-zinc-600"
              }`} />
              <span>
                {(poll.peerCount ?? 0) === 1
                  ? "1 peer connected"
                  : `${poll.peerCount ?? 0} peers connected`}
              </span>
            </div>
          )}

          {/* Firewall hint — shown when stuck with 0 peers for a while */}
          {poll.status === "syncing" && (poll.peerCount ?? 0) === 0 && elapsed > 30 && (
            <p className="text-xs text-yellow-600/80">
              No peers found. If Windows Firewall prompted you, click "Allow". Otherwise check
              that UDP/TCP port 30304 is reachable.
            </p>
          )}

          {/* Syncing progress */}
          {poll.status === "syncing" && poll.syncInfo && (
            <SyncProgress
              current={poll.syncInfo.current}
              highest={poll.syncInfo.highest}
              rate={syncRate}
            />
          )}

          {/* Mining stats */}
          {isMining && (
            <div className="flex gap-6 pt-1">
              <div>
                <p className={LABEL}>Hashrate</p>
                <p className="text-2xl font-bold text-peer tabular-nums">
                  {formatHashrate(poll.hashrate ?? 0)}
                </p>
              </div>
              <div>
                <p className={LABEL}>Block</p>
                <p className="text-2xl font-bold text-white tabular-nums">
                  {(poll.blockNumber ?? 0).toLocaleString()}
                </p>
              </div>
              <div>
                <p className={LABEL}>Peers</p>
                <p className="text-2xl font-bold text-white tabular-nums">
                  {poll.peerCount ?? 0}
                </p>
              </div>
            </div>
          )}

          {/* Starting — block number if available */}
          {poll.status === "syncing" && !poll.syncInfo && poll.blockNumber !== undefined && poll.blockNumber > 0 && (
            <p className="text-xs text-zinc-600 tabular-nums">
              Local block: {poll.blockNumber.toLocaleString()}
            </p>
          )}
        </div>

        {/* ── Thread selector — only adjustable when stopped ── */}
        <div className={`bg-zinc-900 border border-zinc-800 rounded-xl p-5 ${running ? "opacity-50" : ""}`}>
          <p className={LABEL}>Mining Threads</p>
          <div className="flex items-center justify-center gap-6">
            <button
              disabled={running}
              onClick={() => setThreads((t) => Math.max(1, t - 1))}
              className="w-9 h-9 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white text-xl font-light transition-colors disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              −
            </button>
            <span className="text-3xl font-bold tabular-nums w-10 text-center">{threads}</span>
            <button
              disabled={running}
              onClick={() => setThreads((t) => Math.min(16, t + 1))}
              className="w-9 h-9 rounded-lg border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white text-xl font-light transition-colors disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
            >
              +
            </button>
          </div>
          <p className="text-xs text-zinc-600 text-center mt-2">
            Default 2 — conservative for background mining. Max 16.
          </p>
        </div>

        {/* ── Start / Stop button ── */}
        {isStopped ? (
          <button
            onClick={handleStart}
            disabled={toggling}
            className="w-full bg-peer hover:bg-peer-dark disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium py-3 rounded-xl transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            {toggling ? "Starting…" : "Start Mining"}
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={toggling}
            className="w-full border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white disabled:opacity-50 text-sm font-medium py-3 rounded-xl transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            {toggling ? "Stopping…" : "Stop Mining"}
          </button>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="bg-red-950/60 border border-red-800/60 text-red-300 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        {/* ── Info strip ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <p className={LABEL}>Rewards Address</p>
          <p className="font-mono text-xs text-zinc-400 break-all">{address}</p>
        </div>

      </main>
    </div>
  );
}
