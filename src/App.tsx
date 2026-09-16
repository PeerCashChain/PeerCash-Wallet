import { useState, useEffect } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { getAccount } from "./lib/account";
import Setup from "./screens/Setup";
import Wallet from "./screens/Wallet";
import MinerTab from "./screens/MinerTab";
import "./App.css";

type Screen = "loading" | "setup" | "wallet";
type Tab = "wallet" | "miner";
type UpdateStatus = "idle" | "available" | "downloading" | "ready" | "error";

function TabBar({ tab, onSwitch }: { tab: Tab; onSwitch: (t: Tab) => void }) {
  return (
    <div className="border-t border-zinc-800 bg-zinc-950 flex shrink-0">
      {(["wallet", "miner"] as Tab[]).map((t) => (
        <button
          key={t}
          onClick={() => onSwitch(t)}
          className={`flex-1 py-3 text-sm font-medium transition-colors cursor-pointer capitalize ${
            tab === t
              ? "text-peer border-t-2 border-peer -mt-px"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {t === "wallet" ? "Wallet" : "⛏ Miner"}
        </button>
      ))}
    </div>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [address, setAddress] = useState("");
  const [tab, setTab] = useState<Tab>("wallet");
  const [version, setVersion] = useState("");

  // ── Update state ──────────────────────────────────────────────────────────
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
  const [downloadPct, setDownloadPct] = useState(0);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    getAccount()
      .then((addr) => {
        if (addr) {
          setAddress(addr);
          setScreen("wallet");
        } else {
          setScreen("setup");
        }
      })
      .catch(() => setScreen("setup"));
  }, []);

  // Check for updates 4 seconds after the wallet screen appears.
  useEffect(() => {
    if (screen !== "wallet") return;
    const timer = setTimeout(async () => {
      try {
        const u = await check();
        if (u?.available) {
          setUpdate(u);
          setUpdateStatus("available");
        }
      } catch {
        // offline or endpoint unreachable — silently ignore
      }
    }, 4000);
    return () => clearTimeout(timer);
  }, [screen]);

  async function handleInstall() {
    if (!update) return;
    setUpdateStatus("downloading");
    setDownloadPct(0);
    let downloaded = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (total > 0) setDownloadPct(Math.round((downloaded / total) * 100));
        } else if (event.event === "Finished") {
          setUpdateStatus("ready");
        }
      });
    } catch {
      setUpdateStatus("error");
    }
  }

  // ── Update banner ─────────────────────────────────────────────────────────
  function UpdateBanner() {
    if (updateStatus === "idle") return null;

    if (updateStatus === "available" && update) {
      return (
        <div className="bg-zinc-900 border-b border-peer/30 px-4 py-2 flex items-center justify-between">
          <span className="text-sm text-zinc-300">
            Update available:{" "}
            <span className="text-peer font-medium">v{update.version}</span>
          </span>
          <button
            onClick={handleInstall}
            className="text-xs text-peer hover:text-white border border-peer/40 hover:border-peer px-3 py-1 rounded-md transition-colors cursor-pointer"
          >
            Install & Restart
          </button>
        </div>
      );
    }

    if (updateStatus === "downloading") {
      return (
        <div className="bg-zinc-900 border-b border-peer/30 px-4 py-2 space-y-1.5">
          <div className="flex justify-between text-xs text-zinc-400">
            <span>Downloading update…</span>
            <span>{downloadPct}%</span>
          </div>
          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-peer rounded-full transition-all duration-300"
              style={{ width: `${downloadPct}%` }}
            />
          </div>
        </div>
      );
    }

    if (updateStatus === "ready") {
      return (
        <div className="bg-zinc-900 border-b border-peer/30 px-4 py-2 flex items-center justify-between">
          <span className="text-sm text-zinc-300">Update installed</span>
          <button
            onClick={() => relaunch()}
            className="text-xs text-peer hover:text-white border border-peer/40 hover:border-peer px-3 py-1 rounded-md transition-colors cursor-pointer"
          >
            Restart Now
          </button>
        </div>
      );
    }

    if (updateStatus === "error") {
      return (
        <div className="bg-zinc-900 border-b border-red-800/40 px-4 py-2 flex items-center justify-between">
          <span className="text-sm text-red-400">Update failed — try again later</span>
          <button
            onClick={() => setUpdateStatus("idle")}
            className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      );
    }

    return null;
  }

  if (screen === "loading") {
    return (
      <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
        <img src="/logo.jpg" alt="PeerCash" className="w-16 h-16 rounded-full animate-pulse" />
      </div>
    );
  }

  if (screen === "setup") {
    return (
      <Setup
        onComplete={(addr) => {
          setAddress(addr);
          setScreen("wallet");
        }}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <UpdateBanner />
      <div className="flex-1 overflow-auto min-h-0">
        {tab === "wallet"
          ? <Wallet address={address} />
          : <MinerTab address={address} />
        }
      </div>
      <TabBar tab={tab} onSwitch={setTab} />
      {version && (
        <div className="bg-zinc-950 text-center pb-1">
          <span className="text-[10px] text-zinc-700">v{version}</span>
        </div>
      )}
    </div>
  );
}
