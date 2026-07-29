# Security policy

HTML passed to this library must be treated as untrusted input.

## Host responsibilities

- Use a sandboxed iframe. The smallest useful policy is usually `sandbox="allow-scripts"` without `allow-same-origin`.
- Validate `MessageEvent.source` against the iframe's `contentWindow` before accepting any bridge message.
- Validate message payloads again in the host. Message names are routing hints, not authorization.
- Keep file, process, credential, clipboard, payment, and network authority outside the iframe.
- Pass external navigation through `normalizeHtmlArtifactExternalUrl` or an equally strict host policy.
- Apply a Content Security Policy appropriate for the host's threat model.

The generated iframe shell reports runtime errors but does not grant host capabilities. Its `postMessage` bridge is a request channel only.

## Reporting a vulnerability

Please avoid filing public exploit details before a fix is available. Contact the maintainer through the security reporting channel on the GitHub repository.
