# Contributing

Contributions are welcome when they preserve the host-agnostic boundary.

1. Create a focused branch.
2. Add or update tests for protocol, sizing, URL, shell, or bridge behavior.
3. Run `npm run check`.
4. Explain the host/runtime impact in the pull request.

Product prompts, Desktop UI, agent orchestration, and private VelarOS policy do not belong in this repository. New public APIs should work without React or Electron.
