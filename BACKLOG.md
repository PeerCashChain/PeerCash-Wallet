# PeerCash Wallet — Backlog

## Pending

- [x] Version display (show current app version in UI)
- [ ] Miner % synced (show sync progress in miner tab)
- [x] Miner state persistence (save sync progress so restarts don't re-sync from scratch)
- [x] Chain state retained across restarts (graceful shutdown via CTRL_BREAK so go-ethereum flushes trie)
      NOTE (v0.1.8): the v0.1.6/0.1.7 CTRL_BREAK never actually reached the miner — a GUI
      (console-less) process can't target another process's console group. Fixed by calling
      AttachConsole(miner_pid) before GenerateConsoleCtrlEvent. Verified against a copy of the
      real datadir: geth now logs "Got interrupt" → "Persisted dirty state to file
      (merkle.journal)" → "Blockchain stopped" (exit 0), and the restart no longer rewinds.
