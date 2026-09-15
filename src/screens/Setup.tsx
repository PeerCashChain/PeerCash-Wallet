import { useState, useEffect, type FormEvent } from "react";
import { createAccount, getKeystoreJson, importPrivateKey, importKeystore } from "../lib/account";

type Step =
  | "welcome"
  | "create-password"
  | "backup"
  | "import-method"
  | "import-key"
  | "import-keystore";

interface Props {
  onComplete: (address: string) => void;
}

const INPUT =
  "w-full bg-zinc-900 border border-zinc-700 focus:border-peer rounded-lg px-4 py-2.5 text-sm text-white placeholder-zinc-600 focus:outline-none transition-colors";
const BTN_PRIMARY =
  "w-full bg-peer hover:bg-peer-dark disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer disabled:cursor-not-allowed";
const BTN_OUTLINE =
  "w-full border border-zinc-700 hover:border-zinc-500 text-zinc-300 hover:text-white text-sm font-medium py-2.5 rounded-lg transition-colors cursor-pointer";
const LABEL =
  "block text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1.5";

export default function Setup({ onComplete }: Props) {
  const [step, setStep] = useState<Step>("welcome");

  // Create flow
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdAddress, setCreatedAddress] = useState("");
  const [keystoreJson, setKeystoreJson] = useState("");
  const [backupSaved, setBackupSaved] = useState(false);
  const [ksCopied, setKsCopied] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);

  // Import flow
  const [importKey, setImportKey] = useState("");
  const [importJson, setImportJson] = useState("");
  const [importPassword, setImportPassword] = useState("");
  const [showImportPassword, setShowImportPassword] = useState(false);
  const [importing, setImporting] = useState(false);

  const [error, setError] = useState("");

  // Fetch keystore JSON from disk when entering the backup step — never transmitted at creation time.
  useEffect(() => {
    if (step !== "backup") return;
    getKeystoreJson()
      .then(setKeystoreJson)
      .catch(() => setKeystoreJson("Error reading keystore — check app data directory"));
  }, [step]);

  function goBack() {
    setError("");
    if (step === "create-password") setStep("welcome");
    else if (step === "import-method") setStep("welcome");
    else if (step === "import-key" || step === "import-keystore")
      setStep("import-method");
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    setCreating(true);
    try {
      const address = await createAccount(password);
      setCreatedAddress(address);
      setStep("backup"); // keystoreJson fetched via useEffect on step change
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create account");
    } finally {
      setCreating(false);
    }
  }

  async function handleImportKey(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!importKey.trim()) {
      setError("Private key is required");
      return;
    }
    if (importPassword.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setImporting(true);
    try {
      const addr = await importPrivateKey(importKey.trim(), importPassword);
      setImportKey(""); // clear from state immediately after use
      onComplete(addr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  async function handleImportKeystore(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!importJson.trim()) {
      setError("Keystore JSON is required");
      return;
    }
    if (!importPassword) {
      setError("Password is required");
      return;
    }
    setImporting(true);
    try {
      const addr = await importKeystore(importJson.trim(), importPassword);
      onComplete(addr);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Import failed — wrong password?",
      );
    } finally {
      setImporting(false);
    }
  }

  async function copyKeystore() {
    await navigator.clipboard.writeText(keystoreJson);
    setKsCopied(true);
    setTimeout(() => setKsCopied(false), 2000);
  }

  async function copyAddress() {
    await navigator.clipboard.writeText(createdAddress);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  }

  const showBack =
    step !== "welcome" && step !== "backup";

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex flex-col select-none">
      <header className="flex items-center px-6 py-4 border-b border-zinc-800/60">
        {showBack ? (
          <button
            onClick={goBack}
            className="text-zinc-400 hover:text-white text-sm transition-colors cursor-pointer mr-4"
          >
            ← Back
          </button>
        ) : (
          <div className="w-16" />
        )}
        <div className="flex items-center gap-2.5 mx-auto">
          <img src="/logo.jpg" alt="PeerCash" className="w-7 h-7 rounded-full" />
          <span className="font-semibold tracking-tight">PeerCash</span>
        </div>
        <div className="w-16" />
      </header>

      <main className="flex-1 flex flex-col justify-center px-6 py-8 w-full max-w-md mx-auto">
        {/* ── Welcome ── */}
        {step === "welcome" && (
          <div className="space-y-6">
            <div className="text-center space-y-2">
              <img
                src="/logo.jpg"
                alt="PeerCash"
                className="w-20 h-20 rounded-full mx-auto mb-4"
              />
              <h1 className="text-2xl font-bold">Welcome to PeerCash</h1>
              <p className="text-zinc-400 text-sm">
                Create a new account or import an existing one to get started.
              </p>
            </div>
            <div className="space-y-3">
              <button
                className={BTN_PRIMARY}
                onClick={() => {
                  setError("");
                  setPassword("");
                  setConfirmPassword("");
                  setStep("create-password");
                }}
              >
                Create New Account
              </button>
              <button
                className={BTN_OUTLINE}
                onClick={() => {
                  setError("");
                  setStep("import-method");
                }}
              >
                Import Account
              </button>
            </div>
          </div>
        )}

        {/* ── Create: password ── */}
        {step === "create-password" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">Create Account</h2>
              <p className="text-zinc-400 text-sm mt-1">
                Choose a password to encrypt your keystore. You'll need it to
                sign transactions.
              </p>
            </div>
            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className={LABEL}>Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    className={INPUT}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    {showPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              <div>
                <label className={LABEL}>Confirm Password</label>
                <input
                  type={showPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
              {error && (
                <p className="text-red-400 text-xs">{error}</p>
              )}
              <button type="submit" disabled={creating} className={BTN_PRIMARY}>
                {creating ? "Creating…" : "Create Account"}
              </button>
            </form>
          </div>
        )}

        {/* ── Backup ── */}
        {step === "backup" && (
          <div className="space-y-5">
            <div>
              <h2 className="text-xl font-semibold">Save Your Backup</h2>
              <p className="text-zinc-400 text-sm mt-1">
                Your keystore file + password are the only way to recover your
                account. Store them somewhere safe.
              </p>
            </div>

            {/* Address */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
              <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                Your Address
              </p>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-zinc-200 truncate">
                  {createdAddress}
                </span>
                <button
                  onClick={copyAddress}
                  className="shrink-0 text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                >
                  {addrCopied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>

            {/* Keystore */}
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium text-zinc-500 uppercase tracking-wider">
                  Keystore JSON
                </p>
                <button
                  onClick={copyKeystore}
                  className="text-xs text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2.5 py-1 rounded-md transition-colors cursor-pointer"
                >
                  {ksCopied ? "Copied!" : "Copy"}
                </button>
              </div>
              <textarea
                readOnly
                value={keystoreJson}
                rows={4}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-400 resize-none focus:outline-none"
              />
              <p className="text-xs text-yellow-500/80">
                ⚠ Copy this JSON and save it with your password. Without both,
                your funds are unrecoverable.
              </p>
            </div>

            {/* Confirm */}
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={backupSaved}
                onChange={(e) => setBackupSaved(e.target.checked)}
                className="mt-0.5 accent-peer"
              />
              <span className="text-sm text-zinc-300">
                I've copied my keystore JSON and saved my password
              </span>
            </label>

            <button
              disabled={!backupSaved}
              onClick={() => onComplete(createdAddress)}
              className={BTN_PRIMARY}
            >
              Open Wallet
            </button>
          </div>
        )}

        {/* ── Import: method selection ── */}
        {step === "import-method" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">Import Account</h2>
              <p className="text-zinc-400 text-sm mt-1">
                Choose how you'd like to import your existing account.
              </p>
            </div>
            <div className="space-y-3">
              <button
                className={BTN_PRIMARY}
                onClick={() => {
                  setError("");
                  setImportKey("");
                  setImportPassword("");
                  setStep("import-key");
                }}
              >
                Import Private Key
              </button>
              <button
                className={BTN_OUTLINE}
                onClick={() => {
                  setError("");
                  setImportJson("");
                  setImportPassword("");
                  setStep("import-keystore");
                }}
              >
                Import Keystore JSON
              </button>
            </div>
          </div>
        )}

        {/* ── Import: private key ── */}
        {step === "import-key" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">Import Private Key</h2>
              <p className="text-zinc-400 text-sm mt-1">
                Enter your 64-character hex private key and set a new password to
                protect it.
              </p>
            </div>
            <form onSubmit={handleImportKey} className="space-y-4">
              <div>
                <label className={LABEL}>Private Key</label>
                <input
                  type="text"
                  value={importKey}
                  onChange={(e) => setImportKey(e.target.value)}
                  placeholder="0x… or without prefix"
                  spellCheck={false}
                  autoComplete="off"
                  className={`${INPUT} font-mono`}
                />
              </div>
              <div>
                <label className={LABEL}>New Password</label>
                <div className="relative">
                  <input
                    type={showImportPassword ? "text" : "password"}
                    value={importPassword}
                    onChange={(e) => setImportPassword(e.target.value)}
                    placeholder="Min. 8 characters"
                    autoComplete="new-password"
                    className={INPUT}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowImportPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    {showImportPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button type="submit" disabled={importing} className={BTN_PRIMARY}>
                {importing ? "Importing…" : "Import Account"}
              </button>
            </form>
          </div>
        )}

        {/* ── Import: keystore JSON ── */}
        {step === "import-keystore" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold">Import Keystore</h2>
              <p className="text-zinc-400 text-sm mt-1">
                Paste your Web3 keystore JSON and enter the password that encrypts
                it.
              </p>
            </div>
            <form onSubmit={handleImportKeystore} className="space-y-4">
              <div>
                <label className={LABEL}>Keystore JSON</label>
                <textarea
                  value={importJson}
                  onChange={(e) => setImportJson(e.target.value)}
                  placeholder='{"version":3,"crypto":{…}}'
                  spellCheck={false}
                  rows={5}
                  className={`${INPUT} font-mono resize-none`}
                />
              </div>
              <div>
                <label className={LABEL}>Password</label>
                <div className="relative">
                  <input
                    type={showImportPassword ? "text" : "password"}
                    value={importPassword}
                    onChange={(e) => setImportPassword(e.target.value)}
                    placeholder="Keystore password"
                    autoComplete="current-password"
                    className={INPUT}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowImportPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer"
                  >
                    {showImportPassword ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
              {error && <p className="text-red-400 text-xs">{error}</p>}
              <button type="submit" disabled={importing} className={BTN_PRIMARY}>
                {importing ? "Importing…" : "Import Account"}
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
