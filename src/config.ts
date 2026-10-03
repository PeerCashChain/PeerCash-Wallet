import { invoke } from "@tauri-apps/api/core";

// Network definitions live in the Rust backend (src-tauri/src/lib.rs → NETWORKS),
// the single source of truth. The frontend only reads/sets the selection — chain
// id, RPC URL, bootnodes and genesis are all resolved backend-side.
export interface NetworkInfo {
  key: string;
  name: string;
  chainId: number;
  rpcUrl: string;
  currencySymbol: string;
  decimals: number;
}

/** The currently selected network. */
export function getNetwork(): Promise<NetworkInfo> {
  return invoke<NetworkInfo>("get_network");
}

/** All networks the wallet can switch to. */
export function listNetworks(): Promise<NetworkInfo[]> {
  return invoke<NetworkInfo[]>("list_networks");
}

/** Persist and switch the active network. Stops the miner backend-side. */
export function setNetwork(key: string): Promise<NetworkInfo> {
  return invoke<NetworkInfo>("set_network", { key });
}
