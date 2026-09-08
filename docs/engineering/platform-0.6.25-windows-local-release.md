# Platform 0.6.25 Windows local release compatibility

`@velaros-ai/system@1.1.13` includes the Windows process compatibility work first released in
1.1.12: it builds the process-owner map once with
`Get-Process -IncludeUserName` and accepts the native `DateTime` values returned by modern
PowerShell CIM cmdlets. Process listing and start-time queries no longer emit method or DMTF
conversion errors on Windows, and owner inspection no longer performs one CIM method call per
process.

Package CLI builds now mark executable entry points through Node's filesystem API. The maintained
local release path therefore runs on Windows without requiring a separate POSIX `chmod` binary.
Generated preview CSS also normalizes checkout newlines, so a Windows build leaves the verified source
tree byte-for-byte clean.

`@velaros-ai/agent@0.6.15` keeps awaited Hook, model-stream, tool-cancellation, background-job, and
execution-deadline timers referenced until their races settle. This prevents Bun from leaving a
non-settling operation pending forever and keeps both runtime dispatch and the original full Agent
test gate deterministic; observational timers remain unreferenced.
