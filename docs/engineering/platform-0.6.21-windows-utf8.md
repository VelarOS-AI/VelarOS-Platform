# Platform 0.6.21 Windows UTF-8 release

Platform 0.6.21 publishes `@velaros-ai/system@1.1.11`.

The native Windows process host now keeps its inherited console on UTF-8 and starts managed
children without replacing that console. This preserves UTF-8 bytes from redirected CMD output
while retaining Job-object process-tree ownership, literal batch arguments, and exact exit status.

The Windows execution gate verifies the native host against Git Bash and CMD, including Chinese
and emoji output, quoted arguments, metacharacters, batch shims, and non-zero exit codes.
