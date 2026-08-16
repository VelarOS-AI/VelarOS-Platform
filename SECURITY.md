# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's private vulnerability reporting flow from the repository's **Security** tab. Include:

- the affected package and version or commit;
- prerequisites and a minimal reproduction;
- expected and observed impact;
- whether credentials, permissions, local data, remote execution, or cross-host boundaries are involved;
- any suggested mitigation.

If private vulnerability reporting is temporarily unavailable, contact a repository maintainer through the VelarOS-AI organization profile and request a private reporting channel without disclosing vulnerability details publicly.

Maintainers will acknowledge a complete report, assess severity, coordinate a fix, and credit reporters who want recognition. Disclosure timing is coordinated with the reporter after affected users have a practical mitigation.

## Supported versions

Until the first public stable release, security fixes target the current default branch. After stable releases begin, this section will list supported release lines and end-of-support dates.

## Scope

Security-sensitive areas include the Kernel permission model, capability invocation, process and filesystem access, model credentials, memory storage, remote hosts, update verification, browser automation, and generated HTML isolation.
