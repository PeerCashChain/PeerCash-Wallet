import {
  useState,
  useEffect,
  useCallback,
  type FormEvent,
} from "react";
import { getBalance, getBlockNumber, getTransactionReceipt } from "../lib/rpc";
import { sendTransaction } from "../lib/account";
import { CHAIN_NAME, CURRENCY_SYMBOL, RPC_URL } from "../config";

interface Props {
  address: string;
}

type Status = "connecting" | "connected" | "error";
type View = "main" | "send" | "tx-status";
type TxStatus = "pending" | "confirmed" | "failed";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

const INPUT =
  "w-full bg-zinc-900 border border-zinc-700 focus:border-peer rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none transition-colors";
const BTN_PRIMARY =
  "w-full bg-peer hover:bg-peer-dark disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed";
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

  // ── Receipt poller (while on tx-status and still pending) ─────────────────
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
      const hash = await sendTransaction(RPC_URL, recipient, amt, sendPwd);
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

  function openSend() {
    setSendError("");
    setView("send");
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
        {view === "send" && (
          <button
            onClick={() => setView("main")}
            className="text-zinc-400 hover:text-white text-sm transition-colors cursor-pointer w-16"
          >
            ← Cancel
          </button>
        )}
        {view !== "send" && <div className="w-16" />}

        <div className="flex items-center gap-2.5 mx-auto">
          <img src="/logo.jpg" alt="PeerCash" className="w-7 h-7 rounded-full" />
          <span className="font-semibold tracking-tight">PeerCash</span>
        </div>

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
            onClick={openSend}
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

            <button
              type="submit"
              disabled={sending}
              className={BTN_PRIMARY}
            >
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
              {txStatus === "confirmed"
                ? "✓"
                : txStatus === "failed"
                  ? "✗"
                  : "⏳"}
            </div>
            <h2 className="text-xl font-semibold">
              {txStatus === "confirmed"
                ? "Confirmed"
                : txStatus === "failed"
                  ? "Transaction Failed"
                  : "Transaction Sent"}
            </h2>
            {txStatus === "pending" && (
              <p className="text-zinc-400 text-sm">
                Waiting for the next block…
              </p>
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

          {/* Hash */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-5 space-y-2">
            <p className={LABEL}>Transaction Hash</p>
            <div className="flex items-center gap-3">
              <span className="font-mono text-sm text-zinc-300 truncate">
                {shortHash}
              </span>
              <button
                onClick={copyTxHash}
                className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-3 py-1 rounded-md transition-colors cursor-pointer"
              >
                {hashCopied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>

          {/* Status indicator */}
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
              <span className="text-sm text-zinc-300 capitalize">
                {txStatus === "pending" ? "Pending…" : txStatus.charAt(0).toUpperCase() + txStatus.slice(1)}
              </span>
            </div>
          </div>

          <button
            onClick={() => setView("main")}
            className={BTN_PRIMARY}
          >
            Back to Wallet
          </button>
        </main>
      )}
    </div>
  );
}
