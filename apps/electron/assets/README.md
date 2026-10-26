# Electron artwork

The editable master is [app-icon.svg](../../web/public/app-icon.svg), the approved
blue, cyan and gold crescent, sun, bars, mountains and river design. Its viewBox
fits the native geometry; it has a transparent background.

[app-icon.png](../../web/public/app-icon.png) is the 1024 pixel raster used by
windows. `app.ico` contains 32-bit PNG frames at 16, 24, 32, 48, 64, 128 and 256
pixels. Both Windows builder configurations select this icon.

The separate [tray-icon.svg](../../web/public/tray-icon.svg) and
[tray-icon.png](../../web/public/tray-icon.png) are a monochrome alpha mask derived
from the approved vector paths. The tray compositor retains alpha, supplies
contrast backing and adds its existing status/quota information; it no longer
crops or thresholds the previous artwork.

Raster assets were rendered with Inkscape 1.4.4. The ICO is a format conversion
of that PNG at the listed sizes. Future artwork changes must regenerate the
rasters and ICO from the vector, verify dimensions, transparency and frames,
and inspect the result at small sizes on light and dark backgrounds.

Asset inspection does not qualify the installed taskbar, notification identity
or Windows shell. Those require the exact packaged artifact and GUI checks.
