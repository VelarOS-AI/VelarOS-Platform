# Platform 0.6.33 Windows process inspection

`@velaros-ai/system@1.1.16` completes the native Windows inspection path by
using `tasklist.exe /FO CSV /NH` for bounded process discovery. Together with
the `netstat.exe` listener path introduced in System 1.1.15, ordinary System
process inspection no longer depends on PowerShell CIM or NetTCPIP providers.

The native fallback retains stable process identity, name, memory, filtering,
and result limits. Fields unavailable from `tasklist.exe` are returned with
their documented neutral values instead of blocking the complete tool call.
