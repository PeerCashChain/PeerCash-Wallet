import { useState, useEffect } from "react";
import { getAccount } from "./lib/account";
import Setup from "./screens/Setup";
import Wallet from "./screens/Wallet";
import MinerTab from "./screens/MinerTab";
import "./App.css";

type Screen = "loading" | "setup" | "wallet";
type Tab = "wallet" | "miner";

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

  useEffect(() => {
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
      <div className="flex-1 overflow-auto min-h-0">
        {tab === "wallet"
          ? <Wallet address={address} />
          : <MinerTab address={address} />
        }
      </div>
      <TabBar tab={tab} onSwitch={setTab} />
    </div>
  );
}
