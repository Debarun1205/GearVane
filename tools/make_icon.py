"""Generate the GearVane application icon.

Written as a script rather than committing an opaque binary so the icon can
be regenerated or tweaked: change the colours below and re-run.

Produces a 512x512 RGBA PNG. electron-builder derives the platform-specific
forms (.ico, .icns, AppImage icon) from it.
"""

import math
import struct
import zlib
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent.parent / "apps" / "desktop" / "resources" / "icon.png"

SIZE = 512
SUPERSAMPLE = 3  # Anti-aliasing: render larger, then box-filter down.

# Matches the brand gradient used in the site and the app header.
BACKGROUND = (11, 17, 32)  # #0b1120
LOCAL = (34, 197, 94)  # #22c55e
ACCENT = (56, 189, 248)  # #38bdf8
FRONTIER = (244, 114, 182)  # #f472b6


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(a, b, t: float):
    return tuple(int(round(lerp(a[i], b[i], t))) for i in range(3))


def brand_color(t: float):
    """Two-stop gradient: local -> accent -> frontier."""
    if t < 0.5:
        return lerp_color(LOCAL, ACCENT, t * 2)
    return lerp_color(ACCENT, FRONTIER, (t - 0.5) * 2)


def render():
    """Render RGBA pixels at the supersampled resolution."""
    big = SIZE * SUPERSAMPLE
    pixels = []

    centre = big / 2
    # The dot occupies the middle 60%, matching the CSS logo mark.
    dot_radius = big * 0.30
    # Round the background corners slightly for a friendlier app tile.
    corner = big * 0.18

    # The gradient spans the dot's bounding box, not the whole canvas.
    # Mapping it across the canvas would squeeze all visible pixels into the
    # middle of the ramp, leaving the dot a flat wash of cyan.
    dot_min = centre - dot_radius
    dot_span = dot_radius * 2

    def gradient_position(x: float, y: float) -> float:
        """Project a pixel onto the dot's diagonal, normalised to 0..1."""
        along = ((x - dot_min) + (y - dot_min)) / 2
        return max(0.0, min(1.0, along / dot_span))

    for y in range(big):
        row = []
        for x in range(big):
            dx = x + 0.5 - centre
            dy = y + 0.5 - centre
            distance = math.hypot(dx, dy)

            # Alpha for the background tile, with rounded corners.
            alpha = 255
            near_x = abs(x + 0.5 - centre) - (big / 2 - corner)
            near_y = abs(y + 0.5 - centre) - (big / 2 - corner)
            if near_x > 0 and near_y > 0:
                outer = math.hypot(near_x, near_y)
                if outer > corner:
                    alpha = 0

            colour = BACKGROUND
            if alpha:
                if distance <= dot_radius:
                    colour = brand_color(gradient_position(x, y))
                elif distance <= dot_radius + big * 0.02:
                    # Soft edge on the dot.
                    blend = (distance - dot_radius) / (big * 0.02)
                    colour = lerp_color(brand_color(gradient_position(x, y)), BACKGROUND, blend)

            row.append((colour[0], colour[1], colour[2], alpha))
        pixels.append(row)

    return pixels


def downsample(pixels):
    """Box-filter the supersampled image down to SIZE."""
    out = []
    factor = SUPERSAMPLE

    for y in range(SIZE):
        row = bytearray()
        for x in range(SIZE):
            r = g = b = a = 0
            for sy in range(factor):
                source = pixels[y * factor + sy]
                for sx in range(factor):
                    pr, pg, pb, pa = source[x * factor + sx]
                    # Premultiply so transparent edges do not bleed colour.
                    weight = pa / 255
                    r += pr * weight
                    g += pg * weight
                    b += pb * weight
                    a += pa
            samples = factor * factor
            alpha_total = a / samples
            if alpha_total > 0:
                weight_total = a / 255
                row += bytes(
                    (
                        int(round(r / weight_total)),
                        int(round(g / weight_total)),
                        int(round(b / weight_total)),
                        int(round(alpha_total)),
                    )
                )
            else:
                row += b"\x00\x00\x00\x00"
        out.append(bytes(row))
    return out


def chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: Path, rows, width: int, height: int) -> None:
    raw = b"".join(b"\x00" + row for row in rows)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(
        b"IHDR",
        struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0),
    )
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main() -> None:
    pixels = render()
    rows = downsample(pixels)
    write_png(OUTPUT, rows, SIZE, SIZE)

    size_kb = OUTPUT.stat().st_size / 1024
    print(f"wrote {OUTPUT} ({SIZE}x{SIZE}, {size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
