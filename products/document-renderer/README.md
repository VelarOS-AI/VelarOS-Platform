# Velar Document Renderer product

This product packages `@velaros-ai/document-renderer` as an independently installed command
capability pack. It is never copied into Velar Host and Host has no renderer-specific installer,
module, permission branch, or tool route.

Each platform archive contains one native executable, PDF standard-font data, a capability-pack
manifest, and the license. macOS archives are built and notarized on the local release Mac;
Windows and Linux archives are built natively in GitHub Actions.
