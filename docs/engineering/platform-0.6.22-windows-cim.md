# Platform 0.6.22 Windows CIM compatibility

`@velaros-ai/system@1.1.12` builds the process-owner map once with
`Get-Process -IncludeUserName` and accepts the native `DateTime` values returned by modern
PowerShell CIM cmdlets. Process listing and start-time queries no longer emit method or DMTF
conversion errors on Windows, and owner inspection no longer performs one CIM method call per
process.
