# Design QA

## Sources

- Reference — oversized composer attachment remove control: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-695eb6ab-a8cd-43df-9dc0-251151097e26.png`
- Reference — blank `context:distill` compact tool row: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-c85a57e8-e429-4031-a988-4a50293a768e.png`
- Implementation — composer attachment state: `implementation-attachment-crop.png`

## Verification

- The shared attachment remove control renders as a circular 14px control with explicit inline width, minimum width, height, and minimum height, so product-level button CSS cannot enlarge it.
- The remove control remains anchored to the thumbnail corner without covering the attachment preview.
- The component-library `context:distill` fixture renders its `note` after the tool name; when `note` is absent, the summary falls back to the first non-empty fact.
- The same `@velaros-ai/ui` implementation is consumed by Desktop and Workbench.
