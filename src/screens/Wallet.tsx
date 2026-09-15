import {
  useState,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";
import { getBalance, getBlockNumber, getTransactionReceipt } from "../lib/rpc";
import { sendTransaction, exportPrivateKey } from "../lib/account";
import { CHAIN_NAME, CHAIN_ID, CURRENCY_SYMBOL } from "../config";

interface Props {
  address: string;
}

type Status = "connecting" | "connected" | "error";
type View = "main" | "send" | "tx-status" | "settings" | "export-warn" | "export-auth" | "export-reveal";
type TxStatus = "pending" | "confirmed" | "failed";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;
const EXPORT_COUNTDOWN_SECS = 60;

const INPUT =
  "w-full bg-zinc-900 border border-zinc-700 focus:border-peer rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none transition-colors";
const BTN_PRIMARY =
  "w-full bg-peer hover:bg-peer-dark disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed";
const BTN_AMBER =
  "w-full border border-amber-700/60 hover:border-amber-500 disabled:border-zinc-700 disabled:text-zinc-600 text-amber-400 hover:text-amber-300 disabled:cursor-not-allowed text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer";
const LABEL =
  "block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5";

export default function Wallet({ address }: Props) {
  // ── Network state ─────────────────────────────────────────────────────────
  const [balance, setBalance] = useState<string | null>(null);
  const [blockNumber, setBlockNumber] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [addrCopied, setAddrCopied] = useState(false);

  // ── View routing ──────────────────────────────────────────────────────────
  const [view, setView] = useState<View>("main");

  // ── Send form ─────────────────────────────────────────────────────────────
  const [toAddr, setToAddr] = useState("");
  const [amount, setAmount] = useState("");
  const [sendPwd, setSendPwd] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  // ── TX status ─────────────────────────────────────────────────────────────
  const [txHash, setTxHash] = useState("");
  const [txStatus, setTxStatus] = useState<TxStatus>("pending");
  const [txBlock, setTxBlock] = useState<number | null>(null);
  const [hashCopied, setHashCopied] = useState(false);

  // ── Export key flow ───────────────────────────────────────────────────────
  const [exportWarnChecked, setExportWarnChecked] = useState(false);
  const [exportPwd, setExportPwd] = useState("");
  const [showExportPwd, setShowExportPwd] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportedKey, setExportedKey] = useState("");
  const [keyCopied, setKeyCopied] = useState(false);
  const [exportCountdown, setExportCountdown] = useState(EXPORT_COUNTDOWN_SECS);

  // ── Background balance + block poller ─────────────────────────────────────
  const fetchData = useCallback(async () => {
    try {
      const [block, bal] = await Promise.all([
        getBlockNumber(),
        getBalance(address),
      ]);
      setBlockNumber(block);
      setBalance(bal);
      setStatus("connected");
      setErrorMsg("");
      setLastUpdated(new Date());
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : "RPC connection failed");
    }
  }, [address]);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 12_000);
    return () => clearInterval(id);
  }, [fetchData]);

  // ── Receipt poller ────────────────────────────────────────────────────────
  useEffect(() => {
    if (view !== "tx-status" || txStatus !== "pending") return;
    let live = true;

    async function poll() {
      try {
        const receipt = await getTransactionReceipt(txHash);
        if (receipt && live) {
          setTxStatus(receipt.status === "0x1" ? "confirmed" : "failed");
          if (receipt.blockNumber) setTxBlock(parseInt(receipt.blockNumber, 16));
          fetchData();
        }
      } catch {
        // network hiccup — keep polling
      }
    }

    poll();
    const id = setInterval(poll, 3_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [view, txHash, txStatus, fetchData]);

  // ── Export key countdown ──────────────────────────────────────────────────
  useEffect(() => {
    if (view !== "export-reveal") return;
    setExportCountdown(EXPORT_COUNTDOWN_SECS);
    const id = setInterval(() => setExportCountdown(c => c - 1), 1000);
    return () => clearInterval(id);
  }, [view]);

  useEffect(() => {
    if (view === "export-reveal" && exportCountdown <= 0) {
      setExportedKey("");
      setExportPwd("");
      setExportError("");
      setExportWarnChecked(false);
      setShowExportPwd(false);
      setView("settings");
    }
  }, [exportCountdown, view]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  async function copyAddress() {
    await navigator.clipboard.writeText(address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  }

  async function copyTxHash() {
    await navigator.clipboard.writeText(txHash);
    setHashCopied(true);
    setTimeout(() => setHashCopied(false), 2000);
  }

  async function copyExportedKey() {
    await navigator.clipboard.writeText(exportedKey);
    setKeyCopied(true);
    setTimeout(() => setKeyCopied(false), 2000);
  }

  function clearExportFlow() {
    navigator.clipboard.writeText("").catch(() => {});
    setExportedKey("");
    setExportPwd("");
    setExportError("");
    setExportWarnChecked(false);
    setShowExportPwd(false);
    setView("settings");
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    setSendError("");

    const recipient = toAddr.trim();
    if (!ADDR_RE.test(recipient)) {
      setSendError("Invalid address — must be 0x + 40 hex characters");
      return;
    }
    const amt = amount.trim();
    if (!AMOUNT_RE.test(amt) || parseFloat(amt) <= 0) {
      setSendError("Invalid amount — must be a positive decimal number");
      return;
    }
    if (!sendPwd) {
      setSendError("Password is required");
      return;
    }

    setSending(true);
    try {
      const hash = await sendTransaction(recipient, amt, sendPwd);
      setTxHash(hash);
      setTxStatus("pending");
      setTxBlock(null);
      setView("tx-status");
      setToAddr("");
      setAmount("");
      setSendPwd("");
    } catch (e) {
      setSendError(e instanceof Error ? e.message : "Transaction failed");
    } finally {
      setSending(false);
    }
  }

  async function handleExportAuth(e: FormEvent) {
    e.preventDefault();
    setExportError("");
    if (!exportPwd) {
      setExportError("Password is required");
      return;
    }
    setExporting(true);
    try {
      const key = await exportPrivateKey(exportPwd);
      setExportPwd("");
      setExportedKey(key);
      setView("export-reveal");
    } catch (e) {
      setExportError(e instanceof Error ? e.message : "Wrong password");
    } finally {
      setExporting(false);
    }
  }

  // ── Status dot ────────────────────────────────────────────────────────────
  const dotColor =
    status === "connected"
      ? "bg-peer"
      : status === "error"
        ? "bg-red-500"
        : "bg-yellow-400 animate-pulse";

  const statusLabel =
    status === "connected"
      ? "Connected"
      : status === "error"
        ? "Disconnected"
        : "Connecting…";

  const shortHash = txHash
    ? `${txHash.slice(0, 10)}…${txHash.slice(-8)}`
    : "";

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col select-none">
      {/* ── Header ── */}
      <header className="flex items-center px-6 py-4 border-b border-zinc-800/60">
        {/* Left */}
        {view === "send" && (
          <button
            onClick={() => setView("main")}
            className="text-zinc-400 hover:text-white text-sm transition-colors cursor-pointer w-16"
          >
            ← Cancel
          </button>
        )}
        {view === "settings" && (
          <button
            onClick={() => setView("main")}
            className="text-zinc-400 hover:text-white text-sm transition-colors cursor-pointer w-16"
          >
            ← Back
          </button>
        )}
        {view === "export-warn" && (
          <button
            onClick={() => { setExportWarnChecked(false); setView("settings"); }}
            className="text-zinc-400 hover:text-white text-sm transition-colors cursor-pointer w-16"
          >
            ← Back
          </button>
        )}
        {view === "export-auth" && (
          <button
            onClick={() => { setExportError(""); setExportPwd(""); setView("export-warn"); }}
            className="text-zinc-400 hover:text-white text-sm transition-colors cursor-pointer w-16"
          >
            ← Back
          </button>
        )}
        {(view === "main" || view === "tx-status" || view === "export-reveal") && (
          <div className="w-16" />
        )}

        {/* Center */}
        <div className="flex items-center gap-2.5 mx-auto">
          <img src="/logo.jpg" alt="PeerCash" className="w-7 h-7 rounded-full" />
          <span className="font-semibold tracking-tight">PeerCash</span>
        </div>

        {/* Right */}
        <div className="flex items-center gap-2 text-sm w-16 justify-end">
          {view === "main" && (
            <>
              <div className={`w-2 h-2 rounded-full ${dotColor}`} />
              <span className="text-zinc-500 text-xs">{statusLabel}</span>
            </>
          )}
        </div>
      </header>

      {/* ── Main view ── */}
      {view === "main" && (
        <main className="flex-1 px-6 py-8 w-full max-w-lg mx-auto space-y-4">
          {status === "error" && (
            <div className="bg-red-950/60 border border-red-800/60 text-red-300 text-sm px-4 py-3 rounded-lg">
              {errorMsg}
            </div>
          )}

          <div className="flex justify-end">
            <span className="text-xs text-zinc-600">{CHAIN_NAME}</span>
          </div>

          {/* Address */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <p className={LABEL}>Your Address</p>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-zinc-200 truncate">{address}</span>
              <button
                onClick={copyAddress}
                className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1 rounded-md transition-colors cursor-pointer"
              >
                {addrCopied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {/* Balance */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <p className={LABEL}>Balance</p>
            {balance !== null ? (
              <p className="text-3xl font-bold tabular-nums">
                <span className="text-peer">{balance}</span>
                <span className="text-lg text-zinc-500 ml-2">{CURRENCY_SYMBOL}</span>
              </p>
            ) : (
              <div className="h-9 bg-zinc-800 rounded-lg animate-pulse w-44" />
            )}
          </div>

          {/* Send button */}
          <button
            onClick={() => { setSendError(""); setView("send"); }}
            className="w-full bg-peer hover:bg-peer-dark text-white text-sm font-medium py-3 rounded-xl transition-colors cursor-pointer"
          >
            Send PEER
          </button>

          {/* Network */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <p className={LABEL}>Network</p>
            <div className="flex justify-between items-center">
              <span className="text-sm text-zinc-400">Block Height</span>
              {blockNumber !== null ? (
                <span className="text-sm font-mono text-white tabular-nums">
                  {blockNumber.toLocaleString()}
                </span>
              ) : (
                <div className="h-4 bg-zinc-800 rounded animate-pulse w-24" />
              )}
            </div>
          </div>

          {lastUpdated && (
            <p className="text-xs text-zinc-600 text-center pt-1">
              Updated {lastUpdated.toLocaleTimeString()} · refreshes every 12s
            </p>
          )}

          <div className="pt-1 text-center">
            <button
              onClick={() => setView("settings")}
              className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors cursor-pointer"
            >
              Settings
            </button>
          </div>
        </main>
      )}

      {/* ── Send view ── */}
      {view === "send" && (
        <main className="flex-1 px-6 py-8 w-full max-w-md mx-auto space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Send {CURRENCY_SYMBOL}</h2>
            <p className="text-zinc-400 text-sm mt-1">
              Transfers use a fixed gas limit of 21,000. Enter your keystore
              password to sign.
            </p>
          </div>

          <form onSubmit={handleSend} className="space-y-4">
            <div>
              <label className={LABEL}>Recipient Address</label>
              <input
                type="text"
                value={toAddr}
                onChange={(e) => { setToAddr(e.target.value); setSendError(""); }}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className={`${INPUT} font-mono`}
              />
            </div>

            <div>
              <label className={LABEL}>Amount ({CURRENCY_SYMBOL})</label>
              <input
                type="text"
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setSendError(""); }}
                placeholder="0.0"
                inputMode="decimal"
                autoComplete="off"
                className={INPUT}
              />
            </div>

            <div>
              <label className={LABEL}>Keystore Password</label>
              <div className="relative">
                <input
                  type={showPwd ? "text" : "password"}
                  value={sendPwd}
                  onChange={(e) => { setSendPwd(e.target.value); setSendError(""); }}
                  placeholder="Your keystore password"
                  autoComplete="current-password"
                  className={INPUT}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  {showPwd ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {sendError && (
              <p className="text-red-400 text-xs">{sendError}</p>
            )}

            <button type="submit" disabled={sending} className={BTN_PRIMARY}>
              {sending ? "Signing & Broadcasting…" : `Send ${CURRENCY_SYMBOL}`}
            </button>
          </form>
        </main>
      )}

      {/* ── TX status view ── */}
      {view === "tx-status" && (
        <main className="flex-1 px-6 py-8 w-full max-w-md mx-auto space-y-6">
          <div className="text-center space-y-1">
            <div className="text-4xl mb-2">
              {txStatus === "confirmed" ? "✓" : txStatus === "failed" ? "✗" : "⏳"}
            </div>
            <h2 className="text-xl font-semibold">
              {txStatus === "confirmed"
                ? "Confirmed"
                : txStatus === "failed"
                  ? "Transaction Failed"
                  : "Transaction Sent"}
            </h2>
            {txStatus === "pending" && (
              <p className="text-zinc-400 text-sm">Waiting for the next block…</p>
            )}
            {txStatus === "confirmed" && txBlock !== null && (
              <p className="text-zinc-400 text-sm">
                Mined in block {txBlock.toLocaleString()}
              </p>
            )}
            {txStatus === "failed" && (
              <p className="text-zinc-400 text-sm">
                The transaction was included but reverted on-chain.
              </p>
            )}
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
            <p className={LABEL}>Transaction Hash</p>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-zinc-300 truncate">{shortHash}</span>
              <button
                onClick={copyTxHash}
                className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1 rounded-md transition-colors cursor-pointer"
              >
                {hashCopied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5">
            <p className={LABEL}>Status</p>
            <div className="flex items-center gap-3">
              <div
                className={`w-2 h-2 rounded-full ${
                  txStatus === "confirmed"
                    ? "bg-peer"
                    : txStatus === "failed"
                      ? "bg-red-500"
                      : "bg-yellow-400 animate-pulse"
                }`}
              />
              <span className="text-sm text-zinc-300">
                {txStatus === "pending"
                  ? "Pending…"
                  : txStatus.charAt(0).toUpperCase() + txStatus.slice(1)}
              </span>
            </div>
          </div>

          <button onClick={() => setView("main")} className={BTN_PRIMARY}>
            Back to Wallet
          </button>
        </main>
      )}

      {/* ── Settings view ── */}
      {view === "settings" && (
        <main className="flex-1 px-6 py-8 w-full max-w-md mx-auto space-y-6">
          <h2 className="text-xl font-semibold">Settings</h2>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
            <div className="px-5 py-3 flex justify-between items-center">
              <span className="text-sm text-zinc-400">Network</span>
              <span className="text-sm text-zinc-200">{CHAIN_NAME}</span>
            </div>
            <div className="px-5 py-3 flex justify-between items-center">
              <span className="text-sm text-zinc-400">Chain ID</span>
              <span className="text-sm font-mono text-zinc-200">{CHAIN_ID}</span>
            </div>
            <div className="px-5 py-3 flex justify-between items-center">
              <span className="text-sm text-zinc-400">Currency</span>
              <span className="text-sm text-zinc-200">{CURRENCY_SYMBOL}</span>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Advanced</p>
            <button
              onClick={() => {
                setExportWarnChecked(false);
                setExportError("");
                setExportPwd("");
                setView("export-warn");
              }}
              className="w-full border border-amber-800/50 hover:border-amber-600/70 text-amber-500 hover:text-amber-400 text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer text-left px-4"
            >
              Export Private Key
            </button>
          </div>
        </main>
      )}

      {/* ── Export: warning ── */}
      {view === "export-warn" && (
        <main className="flex-1 px-6 py-8 w-full max-w-md mx-auto space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Export Private Key</h2>
            <p className="text-zinc-400 text-sm mt-1">
              Use this to import your PEER wallet into MetaMask via{" "}
              <span className="text-zinc-300">Account → Import Account → Private Key</span>.
            </p>
          </div>

          <div className="bg-amber-950/30 border border-amber-700/50 rounded-xl p-5 space-y-3">
            <p className="text-amber-400 text-sm font-semibold">Warning: sensitive information</p>
            <ul className="text-sm text-zinc-300 space-y-2">
              <li>• Anyone with your private key has permanent, irrevocable control of all funds in this wallet.</li>
              <li>• Never share it with anyone, including anyone claiming to be support staff.</li>
              <li>• Only paste it into MetaMask — never into websites, emails, or chats.</li>
              <li>• Do not screenshot it or store it in any cloud service.</li>
            </ul>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={exportWarnChecked}
              onChange={(e) => setExportWarnChecked(e.target.checked)}
              className="mt-0.5 accent-amber-500"
            />
            <span className="text-sm text-zinc-300">
              I understand the risks and take full responsibility for securing my private key.
            </span>
          </label>

          <button
            disabled={!exportWarnChecked}
            onClick={() => setView("export-auth")}
            className={BTN_AMBER}
          >
            Continue
          </button>
        </main>
      )}

      {/* ── Export: password ── */}
      {view === "export-auth" && (
        <main className="flex-1 px-6 py-8 w-full max-w-md mx-auto space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Confirm Password</h2>
            <p className="text-zinc-400 text-sm mt-1">
              Enter your keystore password to decrypt and reveal your private key.
            </p>
          </div>

          <form onSubmit={handleExportAuth} className="space-y-4">
            <div>
              <label className={LABEL}>Keystore Password</label>
              <div className="relative">
                <input
                  type={showExportPwd ? "text" : "password"}
                  value={exportPwd}
                  onChange={(e) => { setExportPwd(e.target.value); setExportError(""); }}
                  placeholder="Your keystore password"
                  autoComplete="current-password"
                  autoFocus
                  className={INPUT}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowExportPwd((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  {showExportPwd ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {exportError && <p className="text-red-400 text-xs">{exportError}</p>}

            <button type="submit" disabled={exporting} className={BTN_AMBER}>
              {exporting ? "Decrypting…" : "Reveal Private Key"}
            </button>
          </form>
        </main>
      )}

      {/* ── Export: reveal ── */}
      {view === "export-reveal" && (
        <main className="flex-1 px-6 py-8 w-full max-w-md mx-auto space-y-6">
          <div>
            <h2 className="text-xl font-semibold">Your Private Key</h2>
            <p className="text-zinc-400 text-sm mt-1">
              In MetaMask: <span className="text-zinc-300">Account → Import Account → Private Key</span>
            </p>
          </div>

          <div className="bg-zinc-900 border border-amber-800/40 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">Private Key</p>
              <button
                onClick={copyExportedKey}
                className="text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
              >
                {keyCopied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="font-mono text-xs text-zinc-200 break-all select-all leading-relaxed">
              {exportedKey}
            </p>
          </div>

          <p className="text-xs text-zinc-500 text-center">
            Key clears automatically in {exportCountdown}s — close this screen when done.
          </p>

          <button onClick={clearExportFlow} className={BTN_PRIMARY}>
            Done
          </button>
        </main>
      )}
    </div>
  );
}
