# PeerCash Wallet + Miner

PeerCash Wallet is a Windows desktop wallet and CPU miner for the PeerCash testnet.

Create or import a wallet, choose how many CPU threads you want to use, and start mining PEER directly from the app.

No GPU or ASIC is required.

## Requirements

- Windows 10 or Windows 11
- 64-bit system
- Internet connection
- Multi-core CPU recommended

## Download

Download the latest release from:

https://github.com/PeerCashChain/PeerCash-Wallet/releases

For most users, download the Windows installer:

`PeerCash-Wallet_<version>_x64-setup.exe`

The `.msi` package is also available for users who prefer MSI installation.

## Installation

1. Download the latest PeerCash Wallet installer from the Releases page.

2. Run the installer.

3. Windows SmartScreen may display **"Windows protected your PC"** because current testnet builds are not code-signed.

   Click:

   **More info → Run anyway**

4. Complete the installation and launch **PeerCash Wallet**.

## Create a Wallet

On first launch, select **Create Wallet**.

Choose a strong password and store it somewhere safe.

After creating the wallet, PeerCash will provide an encrypted **keystore JSON**.

### Back Up Your Wallet

Save the keystore JSON before you begin mining.

The keystore JSON and your password are required to recover the wallet.

There is currently no recovery phrase and no password reset.

If you lose either the keystore or its password, the wallet cannot be recovered.

Do not post your keystore in Discord, GitHub issues, chat messages, or other public locations.

Do not store an unencrypted copy in a public or shared cloud folder.

## Import an Existing Wallet

If you already have a PeerCash wallet:

1. Open PeerCash Wallet.
2. Select **Import Wallet**.
3. Provide your keystore JSON.
4. Enter the password used to encrypt that keystore.

Your existing PeerCash address and balance will then be available.

## Start Mining

Open the **Miner** tab.

Select the number of CPU threads you want the miner to use.

Then click **Start Mining**.

The wallet launches the PeerCash node and CPU miner automatically.

Once running, the miner will begin participating in the PeerCash testnet and attempting to mine blocks.

Higher thread counts use more of your CPU.

If you want to continue using the computer for other applications while mining, reduce the number of mining threads.

## Stop Mining

Open the **Miner** tab and click **Stop Mining**.

Stopping the miner does not affect your wallet or mined PEER.

You can start mining again at any time.

## Updating PeerCash Wallet

New versions are published on the GitHub Releases page.

To update:

1. Stop mining.
2. Close PeerCash Wallet.
3. Download the newest installer.
4. Run the installer.
5. Launch PeerCash Wallet again.

Your wallet should remain available after an update, but you should always keep a separate backup of your keystore JSON and password.

## Troubleshooting

### "The node process exited unexpectedly"

If PeerCash displays:

> The node process exited unexpectedly. Check that the binary path is correct and try again.

First close PeerCash Wallet completely and reopen it.

If the problem continues:

1. Confirm you installed the latest release.
2. Restart Windows.
3. Reinstall PeerCash Wallet.
4. Check whether antivirus or Windows Defender quarantined one of the PeerCash binaries.
5. Open a GitHub issue and include:
   - PeerCash Wallet version
   - Windows version
   - CPU model
   - Exact error message
   - What happened immediately before the error

Do **not** include your private key, keystore JSON, or wallet password in an issue.

### Miner will not start after an update

Make sure no old PeerCash node or miner process is still running.

Open **Task Manager** and close any remaining PeerCash processes, then launch the updated wallet again.

If the problem persists, report it through GitHub Issues.

### Installer says a file cannot be opened for writing

An older PeerCash process may still be using that file.

Close PeerCash Wallet and check Task Manager for remaining PeerCash processes before running the installer again.

If necessary, restart Windows and rerun the installer.

## CPU Usage

PeerCash mining is CPU-based.

Using more threads generally gives the miner more CPU resources but also leaves fewer resources for games, browsers, development tools, and other applications.

You can lower the thread count whenever you want to use the computer for something else.

## Testnet Notice

PeerCash is currently testnet software under active development.

Testnet PEER has no monetary value.

The network, wallet software, mining implementation, balances, and blockchain state may change or be reset before mainnet.

Testnet mining is intended for testing the network and helping identify bugs.

## Reporting Bugs

Report wallet or miner problems through GitHub Issues:

https://github.com/PeerCashChain/PeerCash-Wallet/issues

Include enough information to reproduce the problem, but **never include private keys, passwords, or keystore contents**.

## License

See the repository license for licensing information.
