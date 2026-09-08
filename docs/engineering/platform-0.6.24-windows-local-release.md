# Platform 0.6.24 Windows local release compatibility

`@velaros-ai/system@1.1.12` builds the process-owner map once with
`Get-Process -IncludeUserName` and accepts the native `DateTime` values returned by modern
PowerShell CIM cmdlets. Process listing and start-time queries no longer emit method or DMTF
conversion errors on Windows, and owner inspection no longer performs one CIM method call per
process.

Package CLI builds now mark executable entry points through Node's filesystem API. The maintained
local release path therefore runs on Windows without requiring a separate POSIX `chmod` binary.
Generated preview CSS also normalizes checkout newlines, so a Windows build leaves the verified source
tree byte-for-byte clean.
