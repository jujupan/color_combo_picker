# Scrap Combo Picker

Upload a photo of fabric scraps. The app shows which of the 348 combinations from Sanzo Wada's
*A Dictionary of Color Combinations* you can make, and which ones are missing only one color.

**Run it:** open `index.html` in a browser. No server or install is needed, and the photo stays on your computer.

## How it works
- The photo is shrunk to about 240px. Edge pixels, where two scraps meet, are skipped.
- Each remaining pixel is compared to the book's 159 colors using CIEDE2000.
  Lightness has half the usual weight (kL=2, the textile convention), so folds and shadows matter less.
- A pixel counts toward a book color if it is within the **tolerance**, and no more than 2.5 ΔE worse
  than the pixel's best match.
- A combo is makeable if each of its colors covers at least the **minimum amount** of the photo.
  Within a combo, every pixel goes to only one of the combo's colors, so a single scrap can't stand in for two of them.
- **Ignoring** a chip, such as your tabletop, drops every pixel whose best match is that color.
- **Clicking the photo** shows the closest book colors. Use "I have it" to add a color the detector missed.

## Data
`data/colors.json` comes from https://github.com/mattdesl/dictionary-of-colour-combinations (MIT License, © 2020 Matt DesLauriers, see `data/LICENSE-colors.md`).
It was spot-checked against the scanned PDF (combos 7, 8, 183, 184, 290).
`python3 build_data.py` regenerates `data/wada.js` from it.
