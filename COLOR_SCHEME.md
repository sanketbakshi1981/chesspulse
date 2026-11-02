# Questoc color scheme

| Role | Hex | CSS token | Usage |
| --- | --- | --- | --- |
| Accent bars | `#0A1F44` | `--accent-bars` | Top bar, running clock, quest accent borders and primary button shadow |
| Text Accent | `#CC9933` | `--text-accent` | Questoc name in the top bar |
| Facet highlights | `#FFD700` | `--facet-highlights` | "Little Chess, Big Adventures" subtitle and keyboard focus rings in the top bar |
| Accent Text | `#3366CC` | `--accent-text` | Accent text, primary buttons, XP values, badges, selections and focus rings on light surfaces |

The palette is defined in [public/style.css](public/style.css). The header uses
navy with gold branding; the rest of the interface uses light blue-tinted
surfaces, navy body text and blue accents. Success and error colors remain
green and red so existing game feedback stays recognizable.

Gold text and yellow highlights belong on dark navy, not white backgrounds.
Connection status uses a light neutral for readability on the dark top bar.
The existing compact mobile layout continues to hide the subtitle.

## Logo

The header and browser icon use
[questoc-logo.png](public/img/chesspieces/questoc-logo.png). Preserve the supplied
artwork and its square aspect ratio; do not stretch, crop or recolor it.
The header displays it at 44 x 44 pixels, or 34 x 34 in the compact layout,
with the accessible label "Questoc logo".
