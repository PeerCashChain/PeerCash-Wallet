import { invoke } from "@tauri-apps/api/core";

export function createAccount(password: string): Promise<string> {
  return invoke("create_account", { password });
}

export function getKeystoreJson(): Promise<string> {
  return invoke("get_keystore_json");
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

export function exportPrivateKey(password: string): Promise<string> {
  return invoke("export_private_key", { password });
}

export function sendTransaction(
  to: string,
  amountPeer: string,
  password: string,
): Promise<string> {
  return invoke("send_transaction", { to, amountPeer, password });
}
