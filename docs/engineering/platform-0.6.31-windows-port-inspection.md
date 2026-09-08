# Platform 0.6.31 Windows port inspection

`@velaros-ai/system@1.1.15` makes Windows listener discovery independent from the
PowerShell networking provider. The System kernel now invokes the bounded native
`netstat.exe -ano -p tcp` command and parses both IPv4 and IPv6 listeners before
joining process metadata through the existing process owner boundary.

This avoids `Get-NetTCPConnection` startup hangs on hosts where the NetTCPIP
provider is unavailable or slow, while preserving the existing process filter,
limit, and current-working-directory enrichment behavior.
