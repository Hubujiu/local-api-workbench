# Same-state HTTP workbench captures

`tests/helpers/http-workbench-visual-baseline.mjs` is invoked from the existing
browser smoke immediately after the established light-theme raw JSON / empty
response fixture. It records light and dark screenshots without sending or
editing the request, asserts draft preservation, then restores the prior theme
and viewport. Default dimensions are exactly 1188 × 848 CSS pixels, matching the native
Apipost standalone 2.0.1 Linux window measured on 2026-11-19. The helper accepts a different viewport when
an independently captured reference requires it.

Outputs in the existing browser artifact:

- `local-api-http-workbench-light.png`
- `local-api-http-workbench-dark.png`
- `local-api-http-workbench.json`

The JSON records exact implementation commit, fixture digest, captured time,
viewport and device pixel ratio, plus actual element geometry and computed font /
color values. It deliberately sets reference to null and fidelity status to
uncompared. These files are implementation evidence, not proof of source parity.
The prior `local-api-reference-dark.png` was captured after hundreds of workflow
actions, so it must not be paired with the old light capture as an identical-state
pixel comparison.

For a valid comparison, separately capture Apipost standalone's installed version,
same visible request content, theme, viewport/device scale and empty response.
Record the reference version and file hashes in the comparison manifest. Do not
resize, auto-align, reuse an online edition screenshot, or treat a marketing
image as proof of the installed version. Preserve Local API branding and existing
accessible controls. Until both actual images are inspected, no visual
conformance result can be reported.


## Native-reference geometry slice

The independently captured 2.0.1 light HTTP POST / raw JSON / unsent reference
has a 44 px title row, 50 px navigation rail, 263 px project tree, 38 px request
tabs, URL row at y=138 with height 40, request tabs ending at y=221, body editor
frame starting at y=273, response separator at y=495 and a 45 px response header.
The reference PNG crops only the bottom 36 px device-identifying status area;
comparison must explicitly crop the implementation to the same top 812 px and
must not resize either image.

The desktop HTTP stacked layout now follows those measured coordinates. Existing
brand, request actions, JSON formatter, expand button, protocol controls and
keyboard focus outlines are retained. Split, expanded-editor and narrow-screen
layouts retain their own behavior. The geometry smoke checks run in both themes;
this is not evidence of matching the reference dark palette, which has not yet
been captured. No proprietary assets were copied.
