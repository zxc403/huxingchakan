from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEXTURE_DIR = ROOT / 'public' / 'textures' / 'processed'
MODEL_DIR = ROOT / 'public' / 'models'
DOCS_DIR = ROOT / 'docs'
PREVIEW_DIR = DOCS_DIR / 'previews'
for directory in (MODEL_DIR, DOCS_DIR, PREVIEW_DIR):
    directory.mkdir(parents=True, exist_ok=True)

WIDTH = 17.2
DEPTH = 14.9
WALL_EXT = 0.24
WALL_INT = 0.12
LOBBY_HEIGHT = 3.6
STANDARD_HEIGHT = 3.0
FLOOR_Z = {1: 0.0, **{floor: 3.6 + (floor - 2) * 3.0 for floor in range(2, 7)}}
RNG_SEED = 51

# Pixel coordinates in the high-resolution plan crop (900,280,1400,1450).
def xy(px, py):
    return (-8.6 + (px - 68) / 1187 * 17.2,
            -7.45 + (1180 - py) / 1027 * 14.9)


def px_bounds(bounds):
    x0, y0, x1, y1 = bounds
    ax, ay = xy(x0, y0)
    bx, by = xy(x1, y1)
    return min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)


ROOMS = {
    'left_living': (433, 754, 711, 1180),
    'left_dining': (295, 470, 540, 881),
    'left_kitchen': (295, 881, 433, 1180),
    'left_master': (68, 153, 295, 470),
    'left_north_bed': (295, 240, 540, 470),
    'left_south_bed': (68, 881, 295, 1180),
    'left_master_bath': (68, 470, 205, 650),
    'left_common_bath': (68, 748, 205, 881),
    'left_balcony': (295, 153, 540, 240),
    'right_living': (710, 754, 984, 1180),
    'right_dining': (710, 470, 984, 881),
    'right_kitchen': (710, 153, 874, 470),
    'right_north_bed': (984, 240, 1255, 470),
    'right_middle_bed': (984, 470, 1255, 748),
    'right_master': (984, 881, 1255, 1180),
    'right_common_bath': (874, 153, 984, 369),
    'right_master_bath': (1084, 748, 1255, 881),
    'right_balcony': (984, 153, 1255, 240),
}

STAIR_PX = (540, 153, 710, 505)
ELEVATOR_PX = (533, 577, 710, 754)
