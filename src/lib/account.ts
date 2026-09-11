import { invoke } from "@tauri-apps/api/core";

export interface CreateAccountResult {
  address: string;
  keystoreJson: string;
}

export function createAccount(password: string): Promise<CreateAccountResult> {
  return invoke("create_account", { password });
}

export function importPrivateKey(
  privateKey: string,
  password: string,
): Promise<string> {
  return invoke("import_private_key", { privateKey, password });
}

export function importKeystore(
  keystoreJson: string,
  password: string,
): Promise<string> {
  return invoke("import_keystore", { keystoreJson, password });
}

export function getAccount(): Promise<string | null> {
  return invoke("get_account");
}

/** Decrypt keystore in Rust, sign a legacy tx, broadcast, return tx hash. */
export function sendTransaction(
  rpcUrl: string,
  to: string,
  amountPeer: string,
  password: string,
): Promise<string> {
  return invoke("send_transaction", { rpcUrl, to, amountPeer, password });
}
