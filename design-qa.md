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

## Adaptive attachment preview QA

### Evidence

- Source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-0893f35b-00ab-4cf8-840e-63ac56d7c957.png`, plus the requested fixed-height, aspect-adaptive-width behavior.
- Earlier implementation: `/tmp/velaros-adaptive-thumb-qa.5w8sQb/implementation.png`.
- Final implementation: `/tmp/velaros-adaptive-thumb-final.i4dpEO/implementation.png`.
- Full-view comparison input: `/tmp/velaros-adaptive-thumb-final.i4dpEO/comparison.png`.
- Focused composer comparison input: `/tmp/velaros-adaptive-thumb-final.i4dpEO/focused-comparison.png`.
- Viewport and state: Desktop conversation composer, light theme, empty task, one 4:1 landscape image and one 1:3 portrait image attached.
- Dimensions and normalization: both full captures are 2560×1640 device pixels for the same 1280×820 CSS-pixel window at 2× density; focused crops are both 1500×600 device pixels. No rescaling was used before comparison.

### Findings

- No actionable P0, P1, or P2 mismatch remains.
- Fonts and typography: composer label and model row retain the existing product typography; attachment sizing does not change text wrapping or hierarchy.
- Spacing and layout rhythm: both previews remain 44px high. The landscape preview expands to the 160px cap, while the portrait preview keeps a 44px minimum frame, preserving the row rhythm without collapsing into a narrow strip.
- Colors and visual tokens: borders, muted surface, remove-control foreground, and composer background continue to use the existing shared tokens.
- Image quality and asset fidelity: `object-fit: contain` preserves each source aspect ratio without stretching or cropping; the fixed 44px height is visibly consistent across the two aspect ratios.
- Copy and content: no product copy changed.
- Interaction and polish: the compact 14px remove control stays anchored to the upper-right corner of each adaptive frame and remains visibly separate from the image content.

### Comparison history

- Iteration 1 — P2: the portrait image's intrinsic aspect ratio reduced the preview to a very narrow strip, making the remove control dominate the frame. Fix: added a 44px minimum width to both the image button and contained image while retaining automatic width and the 160px maximum.
- Iteration 2 — post-fix evidence: the focused comparison shows the portrait frame at 44×44 CSS pixels and the landscape frame at 160×44 CSS pixels, with both images contained and both controls aligned. No further P0/P1/P2 changes were required.

### Implementation checklist

- [x] Keep attachment preview height fixed at 44px.
- [x] Derive width from image aspect ratio.
- [x] Clamp width to 44–160px.
- [x] Preserve image aspect ratio with containment.
- [x] Verify the shared behavior in the running Desktop consumer.

final result: passed

## Sent image presentation and rich-copy QA

### Evidence

- Source visual truth: `/var/folders/qp/3d1vmxms7jqcm8353whb8h_80000gn/T/codex-clipboard-2ae9b5e1-81e8-4913-8afd-e682ecb89086.png`.
- Rendered implementation: `/tmp/velaros-message-image-copy-qa.iSEpOS/pure-image-72dpi.png`.
- Full-view comparison input: `/tmp/velaros-message-image-copy-qa.iSEpOS/full-comparison-normalized.png`.
- Focused sent-message comparison input: `/tmp/velaros-message-image-copy-qa.iSEpOS/focused-comparison.png`.
- Internal copy/paste evidence: `/tmp/velaros-message-image-copy-qa.iSEpOS/internal-paste.png`.
- Live multimodal send evidence: `/tmp/velaros-message-image-copy-qa.iSEpOS/live-send-success.png`.
- Viewport and state: Desktop conversation, light theme, one sent screenshot with accompanying text; the copy/paste check uses the same message and restores it into a new composer.
- Dimensions and normalization: source and rendered full captures are both 2560×1640 device pixels for the same 1280×820 CSS-pixel window. The rendered capture was normalized from 144 DPI metadata to 72 DPI metadata without changing pixel dimensions. Focused source and implementation crops are both 1400×650 pixels and are presented side by side in a 5648×1400 @2x comparison canvas.

### Findings

- No actionable P0, P1, or P2 mismatch remains.
- Fonts and typography: the user message text keeps the existing type scale and weight; image filename and byte-size metadata no longer create a competing text column.
- Spacing and layout rhythm: the sent image occupies the message attachment area directly and the bubble contracts to the image plus the intended message text.
- Colors and visual tokens: the existing user-message surface and radius are preserved; no new colors or borders were introduced.
- Image quality and asset fidelity: the original screenshot remains sharp, uncropped, and aspect-correct. Removing the metadata column gives the image the full available attachment width.
- Copy and content: only the user-authored message remains visible under the image; generated filename and size copy are omitted.
- Interaction and polish: clicking the actual message copy control and pasting into VelarOS restores both the image attachment and message text. A subsequent live send completed and the selected model described the image, so the corrected capability fallback no longer blocks unknown models before the provider is tried.

### Comparison history

- Iteration 1 — P1: the sent-image card reserved a large right-hand metadata pane for a truncated filename and byte count, materially reducing image width. Fix: removed sent-image metadata rendering from the shared attachment-gallery component while retaining metadata for non-image files.
- Iteration 2 — post-fix evidence: the focused side-by-side comparison shows a pure image card with the user text beneath it and no residual right-hand pane. No further P0/P1/P2 visual changes were required.

### Implementation checklist

- [x] Render sent image attachments without filename or size metadata.
- [x] Preserve non-image file labels and sizes.
- [x] Keep external clipboard text link-based.
- [x] Restore rich image/file payloads on internal VelarOS paste.
- [x] Verify an actual copy-button click and internal paste.
- [x] Verify a live image request reaches and completes through the configured model.

final result: passed
