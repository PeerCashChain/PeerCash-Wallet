use k256::ecdsa::{signature::hazmat::PrehashSigner, RecoveryId, Signature, SigningKey};
use rand::{rngs::OsRng, Rng};
use serde_json::{json, Value};
use sha3::{Digest, Keccak256};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;
use zeroize::Zeroizing;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const CTRL_BREAK_EVENT: u32 = 1;

const GAS_LIMIT_TRANSFER: u64 = 21_000;

// Hardcoded local miner-node RPC — never accepted from the frontend to prevent
// SSRF. Network-independent: the local node always listens here regardless of chain.
const MINER_RPC_URL: &str = "http://127.0.0.1:8546";

// 10,000 gwei safety cap on gas price; protects against a compromised RPC endpoint.
const MAX_GAS_PRICE_WEI: u128 = 10_000 * 1_000_000_000;

// Cap on log bytes returned to the renderer to prevent resource exhaustion.
const MAX_LOG_BYTES: u64 = 65_536;

// Lock out after this many consecutive wrong passwords.
const MAX_FAILED_ATTEMPTS: u32 = 5;

// ── Miner constants ───────────────────────────────────────────────────────────
const MINER_HTTP_PORT: &str = "8546";
const MINER_P2P_PORT: &str = "30304";

// ── Network registry ──────────────────────────────────────────────────────────
// Single source of truth for every network. To add a network: append one entry
// here and bundle its genesis under src-tauri/resources/ (+ tauri.conf.json). The
// selected network drives tx signing (chain_id), the public RPC (rpc_url), and the
// miner subprocess (network_id, bootnodes, genesis). The public RPC URL stays
// backend-only (never caller-supplied) to prevent SSRF.
struct Network {
    key: &'static str,              // stable id used in storage + UI
    name: &'static str,             // human-facing display name
    chain_id: u64,                  // EIP-155 signing
    rpc_url: &'static str,          // public JSON-RPC endpoint
    currency_symbol: &'static str,
    decimals: u8,
    network_id: &'static str,       // geth --networkid
    bootnodes: &'static [&'static str],
    genesis_resource: &'static str, // bundled resource filename
    genesis_env: &'static str,      // debug-only env var that overrides the genesis path
}

const NETWORKS: &[Network] = &[
    Network {
        key: "mainnet",
        name: "PeerCash",
        chain_id: 620156,
        rpc_url: "https://rpc.peercash.io",
        currency_symbol: "PEER",
        decimals: 18,
        network_id: "620156",
        bootnodes: &[
            "enode://cc2782823bee8c12c127c0cdd1215ce00e6f0ed5d201900392a3c8942b1d368bdf42891289ecde9d87330caef83dda8b69c80d3e2da03ccb1a462e57ec730104@134.122.29.72:30303",
            "enode://751d49ecf147088282bb0fa0b02f7d1fd683cdacfe08621deb2a8ada09bd1157496180d0a102751cd0384c3fadeba126325dbc6ac9577dbdc7f193cd49ab034d@167.71.85.230:30303",
        ],
        genesis_resource: "mainnet.json",
        genesis_env: "PEERCASH_GENESIS_MAINNET",
    },
    // NOTE: testnet (chainId 563321) is temporarily omitted. It runs the legacy
    // keccak-stub consensus, which the real-RandomX binary we now ship cannot
    // validate. Re-add this entry once testnet is redeployed on real RandomX:
    //   Network { key: "testnet", name: "PeerCash Testnet", chain_id: 563321,
    //             rpc_url: "https://testrpc.peercash.io", currency_symbol: "PEER",
    //             decimals: 18, network_id: "563321",
    //             bootnodes: &["enode://39c0…@167.71.186.249:30303"],
    //             genesis_resource: "testnet.json", genesis_env: "PEERCASH_GENESIS" }
];

// New installs (and upgrades with no saved choice) start here.
const DEFAULT_NETWORK_KEY: &str = "mainnet";

fn network_by_key(key: &str) -> Option<&'static Network> {
    NETWORKS.iter().find(|n| n.key == key)
}

fn default_network() -> &'static Network {
    network_by_key(DEFAULT_NETWORK_KEY).expect("DEFAULT_NETWORK_KEY must exist in NETWORKS")
}

// ── Selected-network state + persistence ──────────────────────────────────────

struct NetworkState(Mutex<&'static Network>);

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedNetwork {
    network: String,
}

fn app_data_base() -> Option<std::path::PathBuf> {
    std::env::var("APPDATA")
        .ok()
        .map(|d| std::path::PathBuf::from(d).join("com.peercash.wallet"))
}

fn network_state_path() -> Option<std::path::PathBuf> {
    app_data_base().map(|d| d.join("network.json"))
}

/// Resolve the network to launch with. Honors a saved choice; otherwise defaults
/// to mainnet. The first time there's no saved choice (a fresh upgrade) we also
/// perform the one-time move of the legacy flat `miner-node/` datadir into
/// `miner-node/testnet/`, so a user who later selects testnet keeps the chain
/// they already synced.
fn load_selected_network() -> &'static Network {
    match network_state_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(data) => serde_json::from_str::<PersistedNetwork>(&data)
            .ok()
            .and_then(|saved| network_by_key(&saved.network))
            .unwrap_or_else(default_network),
        None => {
            migrate_legacy_testnet_datadir();
            default_network()
        }
    }
}

fn save_selected_network(net: &Network) {
    let Some(path) = network_state_path() else { return };
    if let Ok(json) = serde_json::to_string(&PersistedNetwork { network: net.key.to_string() }) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let _ = std::fs::write(&path, json);
    }
}

/// One-time migration: relocate the pre-multinetwork flat datadir
/// (`miner-node/geth`, `miner-node/sync_cache.json`, `miner-node/miner.log`, …)
/// into `miner-node/testnet/`. No-op once a per-network subdir exists or there is
/// nothing synced to move.
fn migrate_legacy_testnet_datadir() {
    let Some(base) = app_data_base() else { return };
    let miner_root = base.join("miner-node");
    // `geth/` is created by `geth init`; its absence means nothing to migrate.
    if !miner_root.join("geth").exists() {
        return;
    }
    let testnet_dir = miner_root.join("testnet");
    if testnet_dir.exists() {
        return; // already migrated
    }
    if std::fs::create_dir_all(&testnet_dir).is_err() {
        return;
    }
    // Collect paths first, then move — don't rename while iterating the dir handle.
    let Ok(entries) = std::fs::read_dir(&miner_root) else { return };
    let to_move: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            // Leave the per-network dirs themselves (testnet/, a future mainnet/, …).
            !NETWORKS.iter().any(|n| n.key == name)
        })
        .collect();
    for from in to_move {
        if let Some(name) = from.file_name() {
            let _ = std::fs::rename(&from, testnet_dir.join(name));
        }
    }
}

// ── Network info (serialized to the renderer) ──────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NetworkInfo {
    key: String,
    name: String,
    chain_id: u64,
    rpc_url: String,
    currency_symbol: String,
    decimals: u8,
}

impl From<&Network> for NetworkInfo {
    fn from(n: &Network) -> Self {
        NetworkInfo {
            key: n.key.to_string(),
            name: n.name.to_string(),
            chain_id: n.chain_id,
            rpc_url: n.rpc_url.to_string(),
            currency_symbol: n.currency_symbol.to_string(),
            decimals: n.decimals,
        }
    }
}

// ── Auth brute-force protection ───────────────────────────────────────────────

struct FailedAttempts {
    count: u32,
    locked_until: Option<Instant>,
}

struct AuthState(Mutex<FailedAttempts>);

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedAuth {
    count: u32,
    locked_until_unix: Option<u64>,
}

fn auth_state_path() -> Option<std::path::PathBuf> {
    std::env::var("APPDATA").ok().map(|d| {
        std::path::PathBuf::from(d)
            .join("com.peercash.wallet")
            .join("auth_state.json")
    })
}

fn load_auth_state() -> FailedAttempts {
    let path = match auth_state_path() {
        Some(p) => p,
        None => return FailedAttempts { count: 0, locked_until: None },
    };
    let data = match std::fs::read_to_string(&path) {
        Ok(d) => d,
        Err(_) => return FailedAttempts { count: 0, locked_until: None },
    };
    let saved: PersistedAuth = match serde_json::from_str(&data) {
        Ok(s) => s,
        Err(_) => return FailedAttempts { count: 0, locked_until: None },
    };
    let locked_until = saved.locked_until_unix.and_then(|unix_secs| {
        let now_unix = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if unix_secs > now_unix {
            Some(Instant::now() + Duration::from_secs(unix_secs - now_unix))
        } else {
            None
        }
    });
    FailedAttempts { count: saved.count, locked_until }
}

fn save_auth_state(guard: &FailedAttempts) {
    let Some(path) = auth_state_path() else { return };
    let locked_until_unix = guard.locked_until.map(|instant| {
        let remaining = instant.saturating_duration_since(Instant::now());
        SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + remaining.as_secs()
    });
    if let Ok(json) = serde_json::to_string(&PersistedAuth { count: guard.count, locked_until_unix }) {
        let _ = std::fs::create_dir_all(path.parent().unwrap_or(&path));
        let _ = std::fs::write(&path, json);
    }
}

fn check_auth_lock(state: &Mutex<FailedAttempts>) -> Result<(), String> {
    let guard = state.lock().unwrap();
    if let Some(until) = guard.locked_until {
        if Instant::now() < until {
            let secs = (until - Instant::now()).as_secs() + 1;
            return Err(format!("Too many failed attempts — try again in {}s.", secs));
        }
    }
    Ok(())
}

fn record_auth_result(state: &Mutex<FailedAttempts>, succeeded: bool) {
    let mut guard = state.lock().unwrap();
    if succeeded {
        guard.count = 0;
        guard.locked_until = None;
    } else {
        guard.count += 1;
        if guard.count >= MAX_FAILED_ATTEMPTS {
            // Exponential backoff: 2^(excess) seconds, capped at 1 hour.
            let delay_secs = (1u64 << (guard.count - MAX_FAILED_ATTEMPTS)).min(3600);
            guard.locked_until = Some(Instant::now() + Duration::from_secs(delay_secs));
        }
    }
    save_auth_state(&guard);
}

// ── Miner process state ───────────────────────────────────────────────────────

// Windows Job Object — kills peercash.exe automatically when the wallet process
// exits for any reason, including forcible termination by the NSIS uninstaller.
struct JobHandle(isize);
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}
impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.0 != 0 { unsafe { CloseHandle(self.0); } }
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attr: *mut std::ffi::c_void, name: *const u16) -> isize;
    fn SetInformationJobObject(job: isize, class: u32, info: *mut std::ffi::c_void, len: u32) -> i32;
    fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    fn CloseHandle(handle: isize) -> i32;
    fn GenerateConsoleCtrlEvent(ctrl_event: u32, process_group_id: u32) -> i32;
    fn AttachConsole(process_id: u32) -> i32;
    fn FreeConsole() -> i32;
    fn SetConsoleCtrlHandler(handler: *mut std::ffi::c_void, add: i32) -> i32;
}

/// Attach to the miner's hidden console and deliver a CTRL_BREAK to its process group.
///
/// `GenerateConsoleCtrlEvent` only reaches a process group that shares the *caller's*
/// console. The wallet is a GUI process with no console, and the miner was spawned with
/// CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP — so it owns its own hidden console that
/// we don't share. Without `AttachConsole(miner_pid)` first, the event is delivered
/// nowhere: geth never runs its SIGINT handler, never calls blockchain.Stop() to flush
/// the trie, and gets hard-killed on timeout — losing all unpersisted state so the next
/// start rewinds tens of thousands of blocks. Attaching to the miner's console fixes the
/// delivery path; targeting the miner's own group id (== pid, since CREATE_NEW_PROCESS_GROUP)
/// keeps the event off our own process.
fn signal_ctrl_break(pid: u32) -> bool {
    unsafe {
        // Detach from any console we may already hold (e.g. `tauri dev` launched from a
        // terminal) so AttachConsole can succeed. No-op for a windowed release build.
        FreeConsole();
        if AttachConsole(pid) == 0 {
            return false;
        }
        // Ignore Ctrl+C in our own process while the event is in flight.
        SetConsoleCtrlHandler(std::ptr::null_mut(), 1);
        let ok = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) != 0;
        // The event is already queued to geth's handler — detach and restore immediately.
        FreeConsole();
        SetConsoleCtrlHandler(std::ptr::null_mut(), 0);
        ok
    }
}

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;

#[repr(C)]
struct JobBasicLimitInfo {
    _per_process_user_time: i64,
    _per_job_user_time:     i64,
    limit_flags:            u32,
    _min_ws:  usize, _max_ws:  usize,
    _active:  u32,   _affinity: usize,
    _priority: u32,  _scheduling: u32,
}

#[repr(C)]
struct JobExtendedLimitInfo {
    basic:              JobBasicLimitInfo,
    _io_info:           [u64; 6],
    _proc_mem_limit:    usize,
    _job_mem_limit:     usize,
    _peak_proc_mem:     usize,
    _peak_job_mem:      usize,
}

struct MinerChild {
    process: Child,
    _job:    JobHandle,
}

struct MinerProcess(Mutex<Option<MinerChild>>);

// ── Sync cache ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize)]
struct SyncCache {
    current: u64,
    highest: u64,
}

fn sync_cache_path(app: &tauri::AppHandle, net: &Network) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("miner-node").join(net.key).join("sync_cache.json"))
}

fn kill_miner_guard(guard: &mut std::sync::MutexGuard<Option<MinerChild>>) {
    if let Some(ref mut mc) = **guard {
        mc.process.kill().ok();
        mc.process.wait().ok();
    }
    **guard = None; // drops MinerChild → drops JobHandle → OS kills peercash.exe
}

/// Graceful shutdown: CTRL_BREAK to the process group, wait up to 10 s for trie flush, hard-kill fallback.
/// taskkill without /F has no effect on CREATE_NO_WINDOW processes (no window to receive WM_CLOSE).
/// GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT) reaches Go's SetConsoleCtrlHandler even without a console
/// window, triggering go-ethereum's SIGTERM handler which calls blockchain.Stop() to flush the trie.
fn graceful_miner_shutdown(guard: &mut std::sync::MutexGuard<Option<MinerChild>>) {
    let pid = match guard.as_ref() {
        Some(mc) => mc.process.id(),
        None => return,
    };

    // Send CTRL_BREAK to the process group (pid == group leader when CREATE_NEW_PROCESS_GROUP was used).
    signal_ctrl_break(pid);

    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if let Some(ref mut mc) = **guard {
            if matches!(mc.process.try_wait(), Ok(Some(_))) {
                **guard = None;
                return;
            }
        } else {
            return;
        }
    }

    kill_miner_guard(guard);
}

// ── Address derivation ────────────────────────────────────────────────────────

fn pk_to_address(pk: &[u8]) -> Result<(String, String), String> {
    let signing_key = SigningKey::from_bytes(pk.into()).map_err(|e| e.to_string())?;
    let point = signing_key.verifying_key().to_encoded_point(false);
    let pubkey = &point.as_bytes()[1..];
    let hash = Keccak256::digest(pubkey);
    let hex_addr = hex::encode(&hash[12..]);
    Ok((format!("0x{hex_addr}"), hex_addr))
}

// ── EIP-55 checksum validation ────────────────────────────────────────────────

fn eip55_checksum_valid(hex40: &str) -> bool {
    let lower = hex40.to_ascii_lowercase();
    let hash = Keccak256::digest(lower.as_bytes());
    for (i, c) in hex40.chars().enumerate() {
        if c.is_ascii_alphabetic() {
            let nibble = (hash[i / 2] >> (if i % 2 == 0 { 4 } else { 0 })) & 0xf;
            if nibble >= 8 && c.is_ascii_lowercase() {
                return false;
            }
            if nibble < 8 && c.is_ascii_uppercase() {
                return false;
            }
        }
    }
    true
}

// ── RLP encoding ─────────────────────────────────────────────────────────────
//
// Integers: minimal big-endian (no leading zeros); 0 → 0x80.
// Byte strings: 0x80+len prefix for len 0..=55, 0xb7+lenlen for longer.
// Lists: 0xc0+payloadlen prefix for len 0..=55, 0xf7+lenlen for longer.

fn rlp_uint(bytes: &[u8]) -> Vec<u8> {
    let start = bytes.iter().position(|&b| b != 0);
    let trimmed = match start {
        None => &[][..],
        Some(i) => &bytes[i..],
    };
    match trimmed {
        [] => vec![0x80],
        [b] if *b < 0x80 => vec![*b],
        _ => {
            let mut out = Vec::with_capacity(1 + trimmed.len());
            out.push(0x80 + trimmed.len() as u8);
            out.extend_from_slice(trimmed);
            out
        }
    }
}

fn rlp_u64(n: u64) -> Vec<u8> {
    rlp_uint(&n.to_be_bytes())
}

fn rlp_u128(n: u128) -> Vec<u8> {
    rlp_uint(&n.to_be_bytes())
}

fn rlp_address(addr: &[u8; 20]) -> Vec<u8> {
    let mut out = Vec::with_capacity(21);
    out.push(0x94); // 0x80 + 20
    out.extend_from_slice(addr);
    out
}

fn rlp_list(items: Vec<Vec<u8>>) -> Vec<u8> {
    let payload: Vec<u8> = items.into_iter().flatten().collect();
    let len = payload.len();
    if len <= 55 {
        let mut out = Vec::with_capacity(1 + len);
        out.push(0xc0 + len as u8);
        out.extend(payload);
        out
    } else {
        let len_be = (len as u64).to_be_bytes();
        let skip = len_be.iter().position(|&b| b != 0).unwrap_or(7);
        let len_len = 8 - skip;
        let mut out = Vec::with_capacity(1 + len_len + len);
        out.push(0xf7 + len_len as u8);
        out.extend_from_slice(&len_be[skip..]);
        out.extend(payload);
        out
    }
}

// ── Transaction signing ───────────────────────────────────────────────────────

fn peer_to_wei(s: &str) -> Result<u128, String> {
    let s = s.trim();
    let (int_part, dec_part) = match s.find('.') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    if !int_part.chars().all(|c| c.is_ascii_digit())
        || !dec_part.chars().all(|c| c.is_ascii_digit())
    {
        return Err("Invalid amount — must be a decimal number".to_string());
    }
    if dec_part.len() > 18 {
        return Err("Too many decimal places (max 18)".to_string());
    }
    let int_val: u128 = if int_part.is_empty() {
        0
    } else {
        int_part.parse().map_err(|_| "Amount too large".to_string())?
    };
    let int_wei = int_val
        .checked_mul(1_000_000_000_000_000_000u128)
        .ok_or("Amount overflow")?;
    let dec_padded = format!("{:0<18}", dec_part);
    let dec_val: u128 = dec_padded.parse().map_err(|_| "Invalid decimal part")?;
    int_wei.checked_add(dec_val).ok_or_else(|| "Amount overflow".to_string())
}

fn parse_hex_u64(s: &str) -> Result<u64, String> {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|e| e.to_string())
}

fn parse_hex_u128(s: &str) -> Result<u128, String> {
    u128::from_str_radix(s.trim_start_matches("0x"), 16).map_err(|e| e.to_string())
}

fn sign_legacy_tx(
    pk: &[u8],
    chain_id: u64,
    nonce: u64,
    gas_price: u128,
    to: &[u8; 20],
    value_wei: u128,
) -> Result<String, String> {
    let signing_key = SigningKey::from_bytes(pk.into()).map_err(|e| e.to_string())?;

    // EIP-155 pre-sign: RLP([nonce, gp, gl, to, value, data, chainId, 0, 0])
    let presign = rlp_list(vec![
        rlp_u64(nonce),
        rlp_u128(gas_price),
        rlp_u64(GAS_LIMIT_TRANSFER),
        rlp_address(to),
        rlp_u128(value_wei),
        vec![0x80], // empty data
        rlp_u64(chain_id),
        vec![0x80],
        vec![0x80],
    ]);
    let hash = Keccak256::digest(&presign);

    let (sig, recid): (Signature, RecoveryId) = signing_key
        .sign_prehash(hash.as_slice())
        .map_err(|e| e.to_string())?;

    let v = recid.to_byte() as u64 + 35 + 2 * chain_id;
    let r_bytes = sig.r().to_bytes();
    let s_bytes = sig.s().to_bytes();

    let signed = rlp_list(vec![
        rlp_u64(nonce),
        rlp_u128(gas_price),
        rlp_u64(GAS_LIMIT_TRANSFER),
        rlp_address(to),
        rlp_u128(value_wei),
        vec![0x80],
        rlp_u64(v),
        rlp_uint(r_bytes.as_slice()),
        rlp_uint(s_bytes.as_slice()),
    ]);

    Ok(format!("0x{}", hex::encode(signed)))
}

// ── Shared RPC helper ─────────────────────────────────────────────────────────

async fn rpc_request(url: &str, method: &str, params: Value) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let resp = client.post(url).json(&body).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = data.get("error") {
        return Err(err["message"].as_str().unwrap_or("RPC error").to_string());
    }
    Ok(data["result"].clone())
}

// ── Keystore helpers ──────────────────────────────────────────────────────────

fn patch_and_save(app_dir: &std::path::Path, pk: &[u8], password: &str) -> Result<(), String> {
    eth_keystore::encrypt_key(app_dir, &mut OsRng, pk, password, Some("keystore"))
        .map_err(|e| e.to_string())?;
    let path = app_dir.join("keystore");
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut ks: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let (_, addr_hex) = pk_to_address(pk)?;
    ks["address"] = Value::String(addr_hex);
    let updated = serde_json::to_string(&ks).map_err(|e| e.to_string())?;
    std::fs::write(&path, &updated).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// JSON-RPC call to the selected network's public RPC. The URL comes from the
/// backend network registry — never caller-supplied — to prevent SSRF.
#[tauri::command]
async fn rpc_call(
    network_state: tauri::State<'_, NetworkState>,
    method: String,
    params: Value,
) -> Result<Value, String> {
    // Copy out the &'static str and drop the guard before awaiting.
    let rpc_url = network_state.0.lock().map_err(|e| e.to_string())?.rpc_url;
    let client = reqwest::Client::new();
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let resp = client
        .post(rpc_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

/// JSON-RPC call to the local miner node (127.0.0.1:8546). URL is hardcoded — never caller-supplied.
#[tauri::command]
async fn miner_rpc_call(method: String, params: Value) -> Result<Value, String> {
    let client = reqwest::Client::new();
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let resp = client
        .post(MINER_RPC_URL)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let data: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
async fn create_account(app: tauri::AppHandle, password: String) -> Result<String, String> {
    if password.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }
    let signing_key = SigningKey::random(&mut OsRng);
    let pk = Zeroizing::new(signing_key.to_bytes().to_vec());
    let (display_addr, _) = pk_to_address(&pk)?;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    patch_and_save(&app_dir, &pk, &password)?;
    Ok(display_addr)
}

/// Read the saved keystore JSON from disk (called by the backup screen — never transmitted at account creation).
#[tauri::command]
async fn get_keystore_json(app: tauri::AppHandle) -> Result<String, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("keystore");
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn import_private_key(
    app: tauri::AppHandle,
    private_key: String,
    password: String,
) -> Result<String, String> {
    if password.len() < 8 {
        return Err("Password must be at least 8 characters".to_string());
    }
    let pk_hex = private_key.trim_start_matches("0x");
    let pk = Zeroizing::new(
        hex::decode(pk_hex).map_err(|_| "Invalid hex private key".to_string())?
    );
    if pk.len() != 32 {
        return Err("Private key must be 32 bytes".to_string());
    }
    let (display_addr, _) = pk_to_address(&pk)?;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;
    patch_and_save(&app_dir, &pk, &password)?;
    Ok(display_addr)
}

#[tauri::command]
async fn import_keystore(
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, AuthState>,
    keystore_json: String,
    password: String,
) -> Result<String, String> {
    check_auth_lock(&auth_state.0)?;

    let ks_value: Value =
        serde_json::from_str(&keystore_json).map_err(|_| "Invalid keystore JSON".to_string())?;
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

    // Random temp filename prevents predictable path; scopeguard-style cleanup ensures deletion.
    let suffix: u64 = OsRng.gen();
    let temp = app_dir.join(format!("_import_{:016x}", suffix));
    std::fs::write(&temp, &keystore_json).map_err(|e| {
        let _ = std::fs::remove_file(&temp); // clean up any partial write
        e.to_string()
    })?;

    let result = eth_keystore::decrypt_key(&temp, &password);
    let _ = std::fs::remove_file(&temp); // always delete, regardless of decrypt result

    let pk = Zeroizing::new(result.map_err(|_| {
        record_auth_result(&auth_state.0, false);
        "Wrong password or invalid keystore".to_string()
    })?);
    record_auth_result(&auth_state.0, true);

    let (display_addr, addr_hex) = pk_to_address(&pk)?;
    let mut ks = ks_value;
    ks["address"] = Value::String(addr_hex);
    let ks_str = serde_json::to_string(&ks).map_err(|e| e.to_string())?;
    std::fs::write(app_dir.join("keystore"), &ks_str).map_err(|e| e.to_string())?;
    Ok(display_addr)
}

#[tauri::command]
async fn export_private_key(
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, AuthState>,
    password: String,
) -> Result<String, String> {
    check_auth_lock(&auth_state.0)?;

    let keystore_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("keystore");

    let pk = Zeroizing::new(
        eth_keystore::decrypt_key(&keystore_path, &password).map_err(|_| {
            record_auth_result(&auth_state.0, false);
            "Wrong password".to_string()
        })?
    );
    record_auth_result(&auth_state.0, true);

    Ok(format!("0x{}", hex::encode(&*pk)))
}

#[tauri::command]
async fn get_account(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("keystore");
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let ks: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    match ks["address"].as_str() {
        Some(a) => Ok(Some(format!("0x{a}"))),
        None => Err("Keystore missing address field — re-import your account".to_string()),
    }
}

/// Decrypt keystore, sign a legacy EIP-155 tx, and broadcast via eth_sendRawTransaction.
#[tauri::command]
async fn send_transaction(
    app: tauri::AppHandle,
    auth_state: tauri::State<'_, AuthState>,
    network_state: tauri::State<'_, NetworkState>,
    to: String,
    amount_peer: String,
    password: String,
) -> Result<String, String> {
    check_auth_lock(&auth_state.0)?;

    // &'static Network is Copy + Send; safe to hold across awaits (the guard is not).
    let net = *network_state.0.lock().map_err(|e| e.to_string())?;

    let keystore_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("keystore");

    let pk = Zeroizing::new(
        eth_keystore::decrypt_key(&keystore_path, &password).map_err(|_| {
            record_auth_result(&auth_state.0, false);
            "Wrong password".to_string()
        })?
    );
    record_auth_result(&auth_state.0, true);

    let (from_addr, _) = pk_to_address(&pk)?;

    let value_wei = peer_to_wei(&amount_peer)?;
    if value_wei == 0 {
        return Err("Amount must be greater than 0".to_string());
    }

    let to_hex = to.trim_start_matches("0x");
    if to_hex.len() != 40 {
        return Err("Recipient address must be 40 hex characters".to_string());
    }
    // Reject mixed-case addresses that fail EIP-55 checksum — catches copy/paste errors.
    let is_mixed_case = to_hex.chars().any(|c| c.is_ascii_uppercase())
        && to_hex.chars().any(|c| c.is_ascii_lowercase());
    if is_mixed_case && !eip55_checksum_valid(to_hex) {
        return Err("Address checksum mismatch — please double-check the recipient address".to_string());
    }
    let to_vec = hex::decode(to_hex).map_err(|_| "Invalid recipient address".to_string())?;
    let to_bytes: [u8; 20] = to_vec.try_into().map_err(|_| "Address length error".to_string())?;

    let nonce_val =
        rpc_request(net.rpc_url, "eth_getTransactionCount", json!([from_addr, "pending"])).await?;
    let nonce = parse_hex_u64(nonce_val.as_str().ok_or("Bad nonce response")?)?;

    let gp_val = rpc_request(net.rpc_url, "eth_gasPrice", json!([])).await?;
    let gas_price = parse_hex_u128(gp_val.as_str().ok_or("Bad gas price response")?)?;

    // Reject absurdly high gas prices from a potentially compromised RPC.
    if gas_price > MAX_GAS_PRICE_WEI {
        return Err(format!(
            "Gas price from RPC ({} gwei) exceeds safety limit of 10,000 gwei — aborting",
            gas_price / 1_000_000_000
        ));
    }

    let raw_tx = sign_legacy_tx(&pk, net.chain_id, nonce, gas_price, &to_bytes, value_wei)?;

    let hash_val = rpc_request(net.rpc_url, "eth_sendRawTransaction", json!([raw_tx])).await?;
    let tx_hash = hash_val.as_str().ok_or("No tx hash in response")?;
    Ok(tx_hash.to_string())
}

// ── Miner commands ────────────────────────────────────────────────────────────

/// Init genesis (if needed) and spawn the peercash node as a background child process.
#[tauri::command]
async fn start_miner(
    app: tauri::AppHandle,
    miner_state: tauri::State<'_, MinerProcess>,
    network_state: tauri::State<'_, NetworkState>,
    address: String,
    threads: u32,
) -> Result<(), String> {
    let net = *network_state.0.lock().map_err(|e| e.to_string())?;
    // Clamp to a sane floor: GETH_RANDOMX_THREADS unset/0 makes the sealer use ALL cores.
    let threads = threads.clamp(1, 64);

    // Validate address before it reaches the subprocess command line.
    let addr_hex = address.trim_start_matches("0x");
    if addr_hex.len() != 40 || !addr_hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid miner address — must be 0x + 40 hex characters".to_string());
    }

    let mut guard = miner_state.0.lock().map_err(|e| e.to_string())?;

    // Check if already running
    if let Some(ref mut mc) = *guard {
        match mc.process.try_wait() {
            Ok(None) => return Err("Miner is already running".to_string()),
            _ => { *guard = None; } // exited — allow restart
        }
    }

    // In debug builds, paths can be overridden via env vars so other devs can run without editing source.
    let binary_path = if cfg!(debug_assertions) {
        std::env::var("PEERCASH_BINARY")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from(r"C:\Users\b_str\peercash-chain\build\bin\peercash.exe"))
    } else {
        // externalBin lands alongside the main exe in the install directory.
        std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or_else(|| "Cannot determine install directory".to_string())?
            .join("peercash.exe")
    };

    let genesis_path = if cfg!(debug_assertions) {
        // Override per network via its env var; otherwise fall back to the bundled
        // resource shipped in-tree (portable, no machine-specific path).
        std::env::var(net.genesis_env)
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources")
                    .join(net.genesis_resource)
            })
    } else {
        // resources are placed in the resource_dir by Tauri's bundler.
        app.path().resource_dir()
            .map_err(|e| e.to_string())?
            .join(net.genesis_resource)
    };

    // Per-network datadir so chains never collide (a shared datadir would fail a
    // genesis-mismatch on switch). Legacy testnet data was moved into testnet/ on upgrade.
    let app_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let datadir = app_dir.join("miner-node").join(net.key);
    std::fs::create_dir_all(&datadir).map_err(|e| e.to_string())?;

    // Init genesis on first run (check for geth/chaindata which init creates)
    let chaindata = datadir.join("geth").join("chaindata");
    if !chaindata.exists() {
        let status = Command::new(&binary_path)
            .args(["init", "--datadir", &datadir.to_string_lossy(), &genesis_path.to_string_lossy()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("Genesis init failed to launch: {e}\nBinary: {}", binary_path.display()))?;

        if !status.success() {
            return Err(format!(
                "Genesis init failed (exit {})\nBinary: {}\nGenesis: {}",
                status.code().unwrap_or(-1),
                binary_path.display(),
                genesis_path.display(),
            ));
        }
    }

    // Redirect stderr to a rolling log file so we can parse hashrate from it.
    let log_path = datadir.join("miner.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|e| format!("Cannot open miner log: {e}"))?;

    let datadir_str = datadir.to_string_lossy().to_string();
    // geth accepts a comma-separated bootnode list; mainnet ships two.
    let bootnodes = net.bootnodes.join(",");
    let child = Command::new(&binary_path)
        .args([
            "--datadir",         &datadir_str,
            "--networkid",       net.network_id,
            "--port",            MINER_P2P_PORT,
            "--bootnodes",       &bootnodes,
            "--syncmode",        "snap",
            "--mine",
            "--miner.etherbase", &address,
            "--http",
            "--http.addr",       "127.0.0.1",
            "--http.port",       MINER_HTTP_PORT,
            "--http.vhosts",     "localhost",
            "--http.corsdomain", "",
            "--http.api",        "eth,net,web3",
        ])
        // This fork reads the mining thread count from this env var; unset → all cores.
        .env("GETH_RANDOMX_THREADS", threads.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file))
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|e| format!("Failed to spawn miner: {e}\nBinary: {}", binary_path.display()))?;

    // Assign peercash.exe to a Job Object with KILL_ON_JOB_CLOSE so the OS
    // terminates it if peercash-wallet.exe exits for any reason (crash, uninstall).
    let job = unsafe { CreateJobObjectW(std::ptr::null_mut(), std::ptr::null()) };
    if job != 0 {
        let mut info: JobExtendedLimitInfo = unsafe { std::mem::zeroed() };
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job,
                JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JobExtendedLimitInfo>() as u32,
            );
            AssignProcessToJobObject(job, child.as_raw_handle() as isize);
        }
    }

    *guard = Some(MinerChild { process: child, _job: JobHandle(job) });
    Ok(())
}

/// Gracefully shut down the miner, waiting up to 5 s for it to flush its state DB.
/// Falls back to a hard kill if the process doesn't exit in time.
#[tauri::command]
async fn stop_miner(miner_state: tauri::State<'_, MinerProcess>) -> Result<(), String> {
    let pid = {
        let guard = miner_state.0.lock().map_err(|e| e.to_string())?;
        guard.as_ref().map(|c| c.process.id())
    };

    if let Some(pid) = pid {
        signal_ctrl_break(pid);

        for _ in 0..20 {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let mut guard = miner_state.0.lock().map_err(|e| e.to_string())?;
            if let Some(ref mut mc) = *guard {
                if matches!(mc.process.try_wait(), Ok(Some(_))) {
                    *guard = None;
                    return Ok(());
                }
            } else {
                return Ok(());
            }
        }
    }

    let mut guard = miner_state.0.lock().map_err(|e| e.to_string())?;
    kill_miner_guard(&mut guard);
    Ok(())
}

/// Read the last `bytes` of the miner's stderr log for hashrate parsing on the JS side.
#[tauri::command]
async fn get_miner_log_tail(
    app: tauri::AppHandle,
    network_state: tauri::State<'_, NetworkState>,
    bytes: u64,
) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let net = *network_state.0.lock().map_err(|e| e.to_string())?;
    let bytes = bytes.min(MAX_LOG_BYTES);
    let log_path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("miner-node")
        .join(net.key)
        .join("miner.log");

    let mut file = std::fs::File::open(&log_path).map_err(|e| e.to_string())?;
    let len = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    let start = len.saturating_sub(bytes);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Returns the PID if the miner process is still running, None if stopped/crashed.
#[tauri::command]
async fn get_miner_pid(miner_state: tauri::State<'_, MinerProcess>) -> Result<Option<u32>, String> {
    let mut guard = miner_state.0.lock().map_err(|e| e.to_string())?;
    match guard.as_mut() {
        None => Ok(None),
        Some(mc) => match mc.process.try_wait().map_err(|e| e.to_string())? {
            None => Ok(Some(mc.process.id())),
            Some(_) => {
                *guard = None;
                Ok(None)
            }
        },
    }
}

#[tauri::command]
async fn get_sync_cache(
    app: tauri::AppHandle,
    network_state: tauri::State<'_, NetworkState>,
) -> Result<Option<SyncCache>, String> {
    let net = *network_state.0.lock().map_err(|e| e.to_string())?;
    let Some(path) = sync_cache_path(&app, net) else { return Ok(None) };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn save_sync_cache(
    app: tauri::AppHandle,
    network_state: tauri::State<'_, NetworkState>,
    current: u64,
    highest: u64,
) -> Result<(), String> {
    let net = *network_state.0.lock().map_err(|e| e.to_string())?;
    let Some(path) = sync_cache_path(&app, net) else { return Ok(()) };
    let dir = path.parent().unwrap_or(&path);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&SyncCache { current, highest }).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}

// ── Network commands ──────────────────────────────────────────────────────────

/// The currently selected network (for display + to seed the selector).
#[tauri::command]
fn get_network(network_state: tauri::State<'_, NetworkState>) -> Result<NetworkInfo, String> {
    let net = *network_state.0.lock().map_err(|e| e.to_string())?;
    Ok(net.into())
}

/// Every network the wallet can switch to, in registry order.
#[tauri::command]
fn list_networks() -> Vec<NetworkInfo> {
    NETWORKS.iter().map(NetworkInfo::from).collect()
}

/// Persist the chosen network and swap it in. The miner is stopped first — it is
/// bound to one chain's datadir/bootnodes and must not outlive the switch.
#[tauri::command]
fn set_network(
    network_state: tauri::State<'_, NetworkState>,
    miner_state: tauri::State<'_, MinerProcess>,
    key: String,
) -> Result<NetworkInfo, String> {
    let net = network_by_key(&key).ok_or_else(|| format!("Unknown network: {key}"))?;
    {
        let mut guard = miner_state.0.lock().map_err(|e| e.to_string())?;
        kill_miner_guard(&mut guard);
    }
    save_selected_network(net);
    *network_state.0.lock().map_err(|e| e.to_string())? = net;
    Ok(net.into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(MinerProcess(Mutex::new(None)))
        .manage(AuthState(Mutex::new(load_auth_state())))
        .manage(NetworkState(Mutex::new(load_selected_network())))
        .invoke_handler(tauri::generate_handler![
            rpc_call,
            miner_rpc_call,
            create_account,
            get_keystore_json,
            import_private_key,
            import_keystore,
            export_private_key,
            get_account,
            send_transaction,
            start_miner,
            stop_miner,
            get_miner_pid,
            get_miner_log_tail,
            get_sync_cache,
            save_sync_cache,
            get_network,
            list_networks,
            set_network,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let state: tauri::State<MinerProcess> = window.state();
                if let Ok(mut guard) = state.0.lock() {
                    graceful_miner_shutdown(&mut guard);
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
