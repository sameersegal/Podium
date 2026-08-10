# Podium brand assets

The source artwork is raster, so these are high-resolution PNGs rather than true vector SVGs.
Scale down freely; scale up only past 1024px if you regenerate the source.

## Logos — `brand/`

| File | Size | Use |
|---|---|---|
| [`podium-logo-horizontal.png`](podium-logo-horizontal.png) | 650×192 | Default horizontal logo, dark navy wordmark, transparent background |
| [`podium-logo-horizontal-light.png`](podium-logo-horizontal-light.png) | 650×192 | Same lockup with a white wordmark, for dark backgrounds |
| [`podium-mark-1024.png`](podium-mark-1024.png) | 1024×1024 | Standalone mark, for app icons and anywhere the wordmark won't fit |
| [`podium-mark-512.png`](podium-mark-512.png) | 512×512 | Smaller standalone mark |

The mark is the gradient **P** on a podium block. Keep clear space around it of at least the
height of the podium base, and don't recolour the gradient.

Theme colour: `#6366F1`. Background: `#FFFFFF`.

## Web icon set — `brand/web/`

Copy the whole directory's contents into the web app's public/static root when one exists;
these files are already named and sized for it, and `site.webmanifest` references them at
absolute paths (`/android-chrome-192x192.png` and so on).

- `favicon.ico`, `favicon-16x16.png`, `favicon-32x32.png`, `favicon-48x48.png`
- `apple-touch-icon.png` — 180×180, iOS home screen
- `android-chrome-192x192.png`, `android-chrome-512x512.png`
- `pwa-maskable-512x512.png` — padded for Android's maskable icon crop
- `og-image.png` — Open Graph / Twitter card image
- `site.webmanifest`

Head markup:

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">

<meta property="og:image" content="/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="/og-image.png">
```

## Naming

Podium is unrelated to podium.com (lead management) and to
[podium-lib](https://podium-lib.io) (micro-frontends), which hold the obvious namespaces. The
npm scope is `@podiumconf/*` (R29); the repository is still named `kms`.
