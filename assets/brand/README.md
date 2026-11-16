# CGP visual identity

CGP's identity is platform-first: modular geometry, visible connections, and a calm technical interface. It must not imply a particular game genre or world.

## Primary identity
- `logo-lockup.svg` — horizontal logo for docs, websites, and title bars.
- `logo-symbol.svg` — standalone platform mark for avatars and compact placements.
- `app-icon.svg` — dark, padded application tile.
- `favicon.svg` — small browser mark.

The mark is an open modular form around a central core. Its interrupted outer paths imply composition and extension; the central facets imply compatible parts forming one whole. Do not rotate, skew, or recolor individual facets independently.

## Palette
| Token | Value | Purpose |
|---|---|---|
| `--cgp-bg` | `#0B1220` | Main application canvas |
| `--cgp-surface` | `#111C2E` | Panels and navigation |
| `--cgp-surface-raised` | `#17263D` | Raised surfaces |
| `--cgp-border` | `#2A405F` | Structural boundaries |
| `--cgp-text` | `#EDF5FF` | Primary text |
| `--cgp-text-muted` | `#A9BCD6` | Secondary text |
| `--cgp-blue` | `#20B7F4` | Primary action and active state |
| `--cgp-cyan` | `#55D9FF` | Focus and highlight |
| `--cgp-violet` | `#8B72F5` | Secondary identity accent |
| `--cgp-green` | `#2BC77A` | Successful/healthy state |
| `--cgp-amber` | `#F2B84B` | Warning state |
| `--cgp-red` | `#F16C75` | Error state |

Blue/cyan is the primary platform color; violet is a restrained secondary accent. Green, amber, and red are semantic status colors, not interchangeable decoration.

## Icons
The SVGs in `icons/` use a 64×64 viewBox, a consistent 2.6-unit stroke, rounded joins, and `currentColor`. They inherit the caller's foreground color.

Module, Slot, Capability, Composition, Lifecycle, Package, Registry, Storage, Wasm, JavaScript, Diagnostics, Simulation, and Save are platform concepts, not game-content icons. Keep them visually neutral.

## Interface components
- `tokens.css` contains framework-independent color, spacing, radius, shadow, and focus tokens.
- `components.css` contains an optional baseline for panels, buttons, controls, badges, and navigation states.
- `ui-preview.svg` is a static reference composition, not a screenshot of an implemented CGP application.

Import `tokens.css` alone when an application already has its own components. Import `components.css` only when its baseline controls are useful. No JavaScript framework is required.

## Accessibility and usage
- Maintain visible keyboard focus.
- Use text labels as well as color for status.
- Respect reduced-motion preferences.
- The current lockup is intended for dark surfaces. Test contrast before using it on light surfaces.
- SVG text uses system-font fallbacks. Convert the wordmark text to paths after selecting and licensing a font if fixed typography is required.

## Design principles
**Modular. Deterministic. Extensible.** Avoid game-controller silhouettes, fantasy scenery, and motifs tied to one example game. CGP is the platform that lets different games and systems compose; its identity should remain useful as the platform evolves.
