import { invoke } from "@tauri-apps/api/core";
import { RPC_URL } from "../config";

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

// Generic JSON-RPC call; returns the .result value (may be string, object, or null).
async function callRaw(method: string, params: unknown[] = []): Promise<unknown> {
  const data = await invoke<RpcResponse>("rpc_call", {
    url: RPC_URL,
    method,
    params,
  });
  if (data.error) throw new Error(`RPC ${data.error.code}: ${data.error.message}`);
  return data.result ?? null;
}

function formatPeer(weiHex: string): string {
  const wei = BigInt(weiHex);
  const ETHER = BigInt("1000000000000000000");
  const whole = wei / ETHER;
  const frac = (wei % ETHER) / BigInt("1000000000000"); // 6 d.p.
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

export async function getBalance(address: string): Promise<string> {
  return formatPeer((await callRaw("eth_getBalance", [address, "latest"])) as string);
}

export async function getBlockNumber(): Promise<number> {
  return parseInt((await callRaw("eth_blockNumber", [])) as string, 16);
}

export interface TxReceipt {
  transactionHash: string;
  blockNumber: string;
  status: string; // "0x1" = success, "0x0" = failure
}

export async function getTransactionReceipt(hash: string): Promise<TxReceipt | null> {
  return (await callRaw("eth_getTransactionReceipt", [hash])) as TxReceipt | null;
}
