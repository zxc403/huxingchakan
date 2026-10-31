import bpy
import math
from mathutils import Vector
from . import geometry as g
from .materials import artwork_material
from .config import ROOT, px_bounds, xy


class Assembly:
    def __init__(self, name, origin, rotation, col):
        self.name, self.origin, self.rotation, self.col = name, origin, rotation, col
        self.root = bpy.data.objects.new(name, None)
        g.collection(col).objects.link(self.root)
        self.root.location = origin
        self.root.rotation_euler.z = rotation
        self.root.empty_display_size = 0.15

    def parent(self, obj):
        obj.parent = self.root
        return obj

    def world(self, loc):
        x, y, z = loc
        c, s = math.cos(self.rotation), math.sin(self.rotation)
        return (self.origin[0] + c*x - s*y, self.origin[1] + s*x + c*y, self.origin[2] + z)

    def box(self, suffix, loc, dims, mat, bevel=0, rot=(0,0,0), collider=False, uv_scale=1):
        obj = g.box(f'{self.name}_{suffix}', loc, dims, mat, self.col, bevel, rot, uv_scale=uv_scale)
        self.parent(obj)
        if collider:
            world_rot = (0, 0, self.rotation)
            g.collision_box(f'{self.name}_{suffix}', self.world(loc), dims, world_rot)
        return obj

    def cylinder(self, suffix, loc, radius, depth, mat, vertices=20, rot=(0,0,0), bevel=0):
        return self.parent(g.cylinder(f'{self.name}_{suffix}', loc, radius, depth, mat, self.col, vertices, rot, bevel))

    def sphere(self, suffix, loc, scale, mat, segments=16, rings=8):
        return self.parent(g.sphere(f'{self.name}_{suffix}', loc, scale, mat, self.col, segments, rings))

    def ico(self, suffix, loc, scale, mat, subdivisions=1):
        return self.parent(g.ico(f'{self.name}_{suffix}', loc, scale, mat, self.col, subdivisions))

    def torus(self, suffix, loc, major, minor, mat, rot=None, major_segments=32):
        return self.parent(g.torus(f'{self.name}_{suffix}', loc, major, minor, mat, self.col, rot, major_segments))

    def rod(self, suffix, start, end, radius, mat, vertices=12):
        obj = g.cylinder_between(f'{self.name}_{suffix}', start, end, radius, mat, self.col, vertices)
        return self.parent(obj)


def flowers(name, origin, col, mats, scale=1.0):
    a = Assembly(name, origin, 0, col)
    a.cylinder('Vase', (0,0,0.13*scale), 0.10*scale, 0.24*scale, mats['water'], 24, bevel=0.015*scale)
    a.sphere('VaseShoulder', (0,0,0.23*scale), (0.105*scale,0.105*scale,0.09*scale), mats['water'])
    for i in range(5):
        angle = i * 2.4
        x, y = math.cos(angle)*0.09*scale, math.sin(angle)*0.09*scale
        top = (x, y, (0.43 + 0.045*(i%2))*scale)
        a.rod(f'Stem{i}', (0,0,0.24*scale), top, 0.008*scale, mats['leaf'], 8)
        for p in range(4):
            theta = p * math.tau / 4
            a.ico(f'Petal{i}_{p}', (top[0]+math.cos(theta)*0.037*scale, top[1]+math.sin(theta)*0.037*scale, top[2]),
                  (0.045*scale,0.032*scale,0.027*scale), mats['flower'] if i%2 else mats['flower_white'])
        a.ico(f'Leaf{i}', (x*0.55+0.035*scale,y*0.55,0.34*scale), (0.07*scale,0.025*scale,0.018*scale), mats['leaf'])
    return a.root


def plant(name, origin, col, mats, scale=1.0):
    a = Assembly(name, origin, 0, col)
    a.cylinder('Pot', (0,0,0.20*scale), 0.23*scale, 0.40*scale, mats['white'], 24, bevel=0.025*scale)
    a.cylinder('Soil', (0,0,0.405*scale), 0.20*scale, 0.025*scale, mats['soil'], 20)
    g.collision_box(f'{name}_Pot', a.world((0,0,0.20*scale)), (0.46*scale,0.46*scale,0.40*scale))
    for i in range(10):
        angle = i * 2.4
        h = (0.65 + (i%4)*0.17)*scale
        end = (math.cos(angle)*0.30*scale, math.sin(angle)*0.30*scale, h)
        a.rod(f'Branch{i}', (0,0,0.38*scale), end, 0.012*scale, mats['leaf'], 8)
        leaf = a.ico(f'Leaf{i}', end, (0.23*scale,0.08*scale,0.035*scale), mats['leaf_light'] if i%3==0 else mats['leaf'], 2)
        leaf.rotation_euler = (0.2*math.sin(angle), 0.35, angle)
    return a.root


def sofa(name, origin, rotation, col, mats):
    a = Assembly(name, origin, rotation, col)
    a.box('Base', (0,0,0.28), (2.85,0.94,0.32), mats['fabric'], 0.10, collider=True)
    a.box('Back', (0,0.38,0.70), (2.82,0.24,0.74), mats['fabric'], 0.09)
    for side in (-1,1):
        a.box(f'Arm{side}', (side*1.35,-0.02,0.57), (0.24,0.98,0.58), mats['fabric'], 0.085)
    for i in range(3):
        x = (i-1)*0.86
        a.box(f'Seat{i}', (x,-0.10,0.52), (0.83,0.74,0.20), mats['fabric'], 0.075)
        back = a.box(f'BackCushion{i}', (x,0.22,0.79), (0.83,0.20,0.49), mats['fabric'], 0.065)
        back.rotation_euler.x = math.radians(-8)
    a.box('ChaiseBase', (-0.92,-0.67,0.29), (0.95,0.78,0.31), mats['fabric'], 0.08, collider=True)
    a.box('ChaiseSeat', (-0.92,-0.69,0.526), (0.86,0.78,0.20), mats['fabric'], 0.07)
    for i, (x,y) in enumerate([(-1.05,0.05),(0.90,0.04),(0.35,0.10)]):
        pillow = a.box(f'Pillow{i}', (x,y,0.83), (0.43,0.18,0.43), mats['pillow'] if i==1 else mats['throw'] if i==2 else mats['linen'], 0.07)
        pillow.rotation_euler = (math.radians(-12), math.radians(8*(-1 if i%2 else 1)), math.radians(8*(i-1)))
    for x in (-1.15,1.15):
        for y in (-0.28,0.28):
            a.cylinder(f'Foot_{x}_{y}', (x,y,0.09), 0.035, 0.18, mats['wood'], 12)
    return a.root


def armchair(name, origin, rotation, col, mats):
    a = Assembly(name, origin, rotation, col)
    a.box('SeatBase', (0,0,0.40), (0.83,0.82,0.25), mats['fabric'], 0.09, collider=True)
    a.box('Seat', (0,-0.05,0.57), (0.68,0.66,0.17), mats['fabric'], 0.07)
    a.box('Back', (0,0.31,0.82), (0.82,0.22,0.70), mats['fabric'], 0.09)
    for side in (-1,1):
        a.box(f'Arm{side}', (side*0.37,0,0.66), (0.16,0.82,0.43), mats['fabric'], 0.06)
        for y in (-0.25,0.25):
            a.rod(f'Leg{side}_{y}', (side*0.30,y,0.32), (side*0.34,y,0.03), 0.025, mats['wood'])
    return a.root


def coffee_table(name, origin, col, mats):
    a = Assembly(name, origin, 0, col)
    a.cylinder('LowerTop', (0,0,0.27), 0.61, 0.065, mats['wood'], 40, bevel=0.015)
    a.cylinder('UpperTop', (0.18,0.04,0.43), 0.46, 0.065, mats['wood'], 40, bevel=0.015)
    for i in range(4):
        angle = i * math.tau/4 + math.pi/4
        a.rod(f'Leg{i}', (math.cos(angle)*0.42,math.sin(angle)*0.42,0.25),
              (math.cos(angle)*0.48,math.sin(angle)*0.48,0.03), 0.022, mats['black'])
    g.collision_box(name, (origin[0],origin[1],origin[2]+0.25), (1.25,1.25,0.50))
    flowers(f'{name}_Florals', (origin[0]+0.10,origin[1],origin[2]+0.47), col, mats, 0.62)
    return a.root


def television_wall(name, origin, rotation, col, mats):
    a = Assembly(name, origin, rotation, col)
    a.box('FloatingCabinet', (0,0,0.52), (2.20,0.40,0.34), mats['wood'], 0.035, collider=True)
    for x in (-0.73,0,0.73):
        a.box(f'Door{x}', (x,-0.213,0.52), (0.69,0.025,0.27), mats['wood'], 0.012)
        a.box(f'Handle{x}', (x,-0.234,0.60), (0.20,0.018,0.015), mats['gold'], 0.005)
    a.box('TVFrame', (0,0.04,1.52), (1.86,0.075,1.08), mats['black'], 0.025)
    a.box('TVScreen', (0,-0.003,1.52), (1.80,0.016,1.02), mats['screen'], 0.012)
    return a.root


def wall_art(name, origin, rotation, col, mats, count=2):
    a = Assembly(name, origin, rotation, col)
    for i in range(count):
        x = (i-(count-1)/2)*0.68
        a.box(f'Frame{i}', (x,0,0), (0.56,0.045,0.84), mats['black'], 0.012)
        art = artwork_material(f'{name}_Artwork{i}', ROOT / 'public' / 'textures' / 'art' / f'art-{i%3+1}.jpg')
        a.box(f'Print{i}', (x,-0.026,0), (0.51,0.009,0.79), art)
    return a.root


def chair(name, origin, rotation, col, mats):
    a = Assembly(name, origin, rotation, col)
    a.box('Seat', (0,0,0.49), (0.48,0.48,0.13), mats['fabric'], 0.045, collider=True)
    a.box('Back', (0,0.20,0.82), (0.49,0.13,0.62), mats['fabric'], 0.045)
    for x in (-0.18,0.18):
        for y in (-0.17,0.17):
            a.rod(f'Leg{x}_{y}', (x,y,0.45), (x*1.1,y*1.1,0.03), 0.025, mats['wood'])
    return a.root


def chandelier(name, origin, col, mats, scale=1.0):
    a = Assembly(name, origin, 0, col)
    a.rod('Stem', (0,0,0), (0,0,0.42*scale), 0.018*scale, mats['gold'])
    a.torus('UpperRing', (0,0,-0.12*scale), 0.34*scale, 0.018*scale, mats['gold'])
    a.torus('LowerRing', (0,0,-0.40*scale), 0.47*scale, 0.022*scale, mats['gold'])
    for i in range(12):
        angle = i*math.tau/12
        x,y = math.cos(angle)*0.45*scale, math.sin(angle)*0.45*scale
        a.rod(f'Arm{i}', (0,0,-0.12*scale), (x,y,-0.34*scale), 0.012*scale, mats['gold'])
        a.ico(f'Crystal{i}', (x,y,-0.52*scale), (0.045*scale,0.045*scale,0.12*scale), mats['crystal'], 1)
        if i%2==0:
            a.sphere(f'Lamp{i}', (x*0.85,y*0.85,-0.25*scale), (0.06*scale,0.06*scale,0.08*scale), mats['light'], 12, 6)
    a.ico('CenterCrystal', (0,0,-0.62*scale), (0.08*scale,0.08*scale,0.16*scale), mats['crystal'], 2)
    return a.root


def dining(name, origin, col, mats):
    x,y,z = origin
    a = Assembly(f'{name}_Table', origin, 0, col)
    a.box('Top', (0,0,0.77), (1.80,0.90,0.085), mats['wood'], 0.035, collider=True, uv_scale=1.5)
    for px in (-0.72,0.72):
        for py in (-0.32,0.32):
            a.box(f'Leg{px}_{py}', (px,py,0.38), (0.075,0.075,0.74), mats['wood'], 0.018)
    for i, px in enumerate((-0.58,0.58)):
        chair(f'{name}_ChairN{i}', (x+px,y+0.78,z), 0, col, mats)
        chair(f'{name}_ChairS{i}', (x+px,y-0.78,z), math.pi, col, mats)
    chair(f'{name}_ChairE', (x+1.18,y,z), math.pi/2, col, mats)
    chair(f'{name}_ChairW', (x-1.18,y,z), -math.pi/2, col, mats)
    chandelier(f'{name}_Chandelier', (x,y,z+2.40), col, mats, 0.85)
    flowers(f'{name}_Centerpiece', (x,y,z+0.83), col, mats, 0.72)
    return a.root


def bed(name, origin, rotation, col, mats, double=True):
    a = Assembly(name, origin, rotation, col)
    width = 1.80 if double else 1.20
    a.box('Frame', (0,0,0.24), (width+0.10,2.15,0.32), mats['wood'], 0.045, collider=True)
    a.box('Mattress', (0,-0.03,0.47), (width,2.02,0.26), mats['linen'], 0.10)
    a.box('Duvet', (0,-0.28,0.64), (width+0.035,1.42,0.13), mats['fabric'], 0.065)
    a.box('Headboard', (0,1.00,0.89), (width+0.18,0.16,1.20), mats['headboard'], 0.065)
    for i in range(2 if double else 1):
        px = (i-0.5)*0.76 if double else 0
        pillow = a.box(f'Pillow{i}', (px,0.64,0.71), (0.66,0.43,0.16), mats['fabric'], 0.065)
        pillow.rotation_euler.x = math.radians(8)
    a.box('Throw', (0,-0.74,0.72), (width+0.05,0.43,0.075), mats['throw'], 0.035)
    for side in (-1,1):
        nx = side*(width/2+0.34)
        a.box(f'Nightstand{side}', (nx,0.69,0.31), (0.48,0.43,0.56), mats['wood'], 0.03, collider=True)
        a.cylinder(f'LampBase{side}', (nx,0.69,0.63), 0.11, 0.06, mats['gold'], 20)
        a.cylinder(f'LampShade{side}', (nx,0.69,0.84), 0.15, 0.30, mats['fabric'], 24)
        a.sphere(f'LampGlow{side}', (nx,0.69,0.79), (0.045,0.045,0.06), mats['light'], 12, 6)
    return a.root


def wardrobe(name, origin, rotation, col, mats, width=1.8):
    a = Assembly(name, origin, rotation, col)
    a.box('Cabinet', (0,0,1.10), (width,0.60,2.20), mats['wood'], 0.025, collider=True)
    doors = max(2, round(width/0.55))
    for i in range(doors):
        x = -width/2 + (i+0.5)*width/doors
        a.box(f'Door{i}', (x,-0.313,1.12), (width/doors-0.025,0.035,2.10), mats['white'], 0.012)
        a.box(f'Handle{i}', (x+0.12,-0.342,1.12), (0.015,0.02,0.26), mats['gold'], 0.004)
    return a.root


def desk(name, origin, rotation, col, mats):
    a = Assembly(name, origin, rotation, col)
    a.box('Top', (0,0,0.75), (1.20,0.55,0.06), mats['wood'], 0.02, collider=True)
    for x in (-0.52,0.52):
        for y in (-0.21,0.21):
            a.box(f'Leg{x}_{y}', (x,y,0.37), (0.045,0.045,0.72), mats['wood'], 0.01)
    a.box('Book', (0.24,0,0.81), (0.30,0.22,0.045), mats['linen'], 0.008)
    a.cylinder('Lamp', (-0.38,0.05,0.91), 0.10, 0.24, mats['gold'], 16)
    chair(f'{name}_Chair', (origin[0],origin[1]-0.62,origin[2]), rotation, col, mats)
    return a.root


def kitchen(name, origin, rotation, col, mats, length=3.2):
    a = Assembly(name, origin, rotation, col)
    a.box('Base', (0,0,0.44), (length,0.64,0.86), mats['white'], 0.018, collider=True)
    a.box('Counter', (0,-0.01,0.91), (length+0.06,0.69,0.065), mats['quartz'], 0.018)
    doors = max(4, round(length/0.60))
    for i in range(doors):
        x = -length/2+(i+0.5)*length/doors
        w = length/doors-0.035
        a.box(f'Door{i}', (x,-0.334,0.46), (w,0.032,0.72), mats['white'], 0.01)
        a.box(f'Inset{i}', (x,-0.354,0.46), (w-0.10,0.012,0.54), mats['cream'], 0.008)
        a.box(f'Handle{i}', (x,-0.375,0.71), (0.18,0.018,0.015), mats['gold'], 0.004)
    a.box('UpperCabinet', (0,0.10,1.93), (length*0.66,0.38,0.70), mats['white'], 0.018)
    for i in range(3):
        x = (i-1)*length*0.20
        a.box(f'UpperDoor{i}', (x,-0.102,1.93), (length*0.20-0.03,0.025,0.64), mats['white'], 0.009)
    # Sink and swan-neck faucet.
    a.box('Sink', (length*0.23,-0.05,0.955), (0.62,0.42,0.035), mats['metal'], 0.04)
    a.box('SinkBasin', (length*0.23,-0.05,0.974), (0.51,0.32,0.02), mats['black'], 0.035)
    a.torus('Faucet', (length*0.23,0.15,1.10), 0.13, 0.018, mats['gold'], (math.pi/2,0,0), 20)
    a.box('Cooktop', (-length*0.23,-0.04,0.955), (0.64,0.46,0.035), mats['black'], 0.02)
    for dx in (-0.18,0.18):
        for dy in (-0.12,0.12):
            a.torus(f'Burner{dx}_{dy}', (-length*0.23+dx,-0.04+dy,0.978), 0.075, 0.012, mats['metal'], major_segments=16)
    a.box('Refrigerator', (-length/2-0.46,0.02,1.03), (0.78,0.72,2.06), mats['metal'], 0.045, collider=True)
    a.box('FridgeUpper', (-length/2-0.46,-0.355,1.34), (0.70,0.028,1.30), mats['quartz'], 0.025)
    a.box('FridgeLower', (-length/2-0.46,-0.355,0.37), (0.70,0.028,0.54), mats['quartz'], 0.025)
    return a.root


def bathroom(name, bounds, floor_z, col, mats):
    x0,y0,x1,y1 = px_bounds(bounds)
    cx,cy = (x0+x1)/2,(y0+y1)/2
    g.box(f'{name}_TileFloor', (cx,cy,floor_z+0.035), (x1-x0-0.08,y1-y0-0.08,0.045), mats['marble'], col, uv_scale=1.6)
    a = Assembly(name, (cx,cy,floor_z), 0, col)
    # Compact toilet: cistern, bowl and seat.
    a.box('Cistern', (x0-cx+0.34,y1-cy-0.25,0.65), (0.42,0.20,0.70), mats['water'], 0.06, collider=True)
    a.sphere('ToiletBowl', (x0-cx+0.34,y1-cy-0.52,0.39), (0.25,0.34,0.25), mats['water'])
    a.torus('ToiletSeat', (x0-cx+0.34,y1-cy-0.54,0.54), 0.20, 0.035, mats['water'], major_segments=24)
    vanity_x = x1-cx-0.48
    a.box('Vanity', (vanity_x,y1-cy-0.34,0.43), (0.78,0.48,0.72), mats['wood'], 0.03, collider=True)
    a.box('VanityTop', (vanity_x,y1-cy-0.34,0.82), (0.82,0.52,0.055), mats['marble'], 0.02)
    a.sphere('Basin', (vanity_x,y1-cy-0.36,0.86), (0.28,0.19,0.09), mats['water'])
    a.box('Mirror', (vanity_x,y1-cy-0.075,1.48), (0.72,0.025,0.90), mats['mirror'], 0.025)
    # Shower screen and rain head.
    a.box('ShowerTray', (x0-cx+0.55,y0-cy+0.58,0.075), (0.95,0.95,0.10), mats['marble'], 0.025)
    a.box('ShowerGlass', (x0-cx+1.02,y0-cy+0.58,1.02), (0.018,0.96,1.95), mats['glass'])
    a.rod('ShowerPipe', (x0-cx+0.20,y0-cy+0.22,0.6), (x0-cx+0.20,y0-cy+0.22,2.05), 0.018, mats['gold'])
    a.cylinder('RainHead', (x0-cx+0.34,y0-cy+0.22,2.05), 0.14, 0.025, mats['gold'], 20)
    return a.root


def living(side, floor_z, col, mats):
    left = side == 'Left'
    bounds = px_bounds((433,881,711,1180) if left else (711,881,984,1180))
    x0,y0,x1,y1 = bounds
    cx,cy = (x0+x1)/2,(y0+y1)/2
    prefix = f'EDIT_{col}_{side}'
    sofa(f'{prefix}Sofa', (x1-0.58 if left else x0+0.58,cy,floor_z), -math.pi/2 if left else math.pi/2, col, mats)
    armchair(f'{col}_{side}_Armchair', (cx+(-0.75 if left else 0.75),cy+0.90,floor_z), math.pi/2 if left else -math.pi/2, col, mats)
    coffee_table(f'{col}_{side}_CoffeeTable', (cx,cy-0.10,floor_z), col, mats)
    television_wall(f'{col}_{side}_TV', (x0+0.24 if left else x1-0.24,cy,floor_z), math.pi/2 if left else -math.pi/2, col, mats)
    g.textured_quad(f'{col}_{side}_MarbleMedallion', (cx,cy,floor_z+0.046), min(2.85,x1-x0-0.58),min(3.10,y1-y0-0.58), mats['medallion'], col)
    wall_art(f'{col}_{side}_Art', (x1-0.15 if left else x0+0.15,cy, floor_z+1.65), -math.pi/2 if left else math.pi/2, col, mats, 2)
    plant(f'{col}_{side}_Plant', (x0+0.48 if left else x1-0.48,y0+0.55,floor_z), col, mats, 0.95)
    # Ceiling tray, warm cove and downlights.
    g.box(f'{col}_{side}_CeilingTray', (cx,cy,floor_z+2.84), (3.45,3.65,0.12), mats['white'], col, bevel_width=0.05)
    for yy in (-1.65,1.65):
        g.box(f'{col}_{side}_Cove{yy}', (cx,cy+yy,floor_z+2.76), (3.20,0.035,0.035), mats['emit'], col)
    for xx in (-1.45,1.45):
        for yy in (-1.45,0,1.45):
            g.cylinder(f'{col}_{side}_Downlight{xx}_{yy}', (cx+xx,cy+yy,floor_z+2.75), 0.065, 0.025, mats['light'], col, 16)
    chandelier(f'{col}_{side}_LivingCrystal', (cx,cy,floor_z+2.56), col, mats, 0.92)


def bedroom(name, bounds, floor_z, col, mats, double=True, master=False):
    x0,y0,x1,y1 = px_bounds(bounds)
    cx,cy = (x0+x1)/2,(y0+y1)/2
    bed(f'EDIT_{col}_{name}_Bed' if master else f'{col}_{name}_Bed', (cx,cy-0.15,floor_z), 0, col, mats, double)
    wardrobe(f'{col}_{name}_Wardrobe', (x1-0.38,cy-0.10,floor_z), math.pi/2, col, mats, min(1.8,y1-y0-0.5))
    if not double:
        desk(f'{col}_{name}_Desk', (x0+0.72,y0+0.52,floor_z), math.pi, col, mats)
    plant(f'{col}_{name}_Plant', (x0+0.35,y0+0.40,floor_z), col, mats, 0.65)
    g.cylinder(f'{col}_{name}_CeilingLight', (cx,cy,floor_z+2.76), 0.24, 0.09, mats['light'], col, 24)


def build_standard_interior(floor, mats):
    col = f'F{floor:02d}'
    z = 3.6 + (floor-2)*3.0
    living('Left', z, col, mats)
    living('Right', z, col, mats)
    dining(f'{col}_LeftDining', (*xy(440,680),z), col, mats)
    dining(f'{col}_RightDining', (*xy(830,680),z), col, mats)
    kitchen(f'{col}_LeftKitchen', (*xy(335,1030),z), math.pi/2, col, mats, 2.55)
    kitchen(f'{col}_RightKitchen', (*xy(745,315),z), math.pi/2, col, mats, 3.25)
    bedroom('LeftMaster', (68,153,295,470), z, col, mats, True, True)
    bedroom('LeftNorth', (295,240,540,470), z, col, mats, False)
    bedroom('LeftSouth', (68,881,295,1180), z, col, mats, False)
    bedroom('RightNorth', (984,240,1255,470), z, col, mats, False)
    bedroom('RightMiddle', (984,470,1255,748), z, col, mats, False)
    bedroom('RightMaster', (984,881,1255,1180), z, col, mats, True, True)
    bathroom(f'{col}_LeftMasterBath', (68,470,205,650), z, col, mats)
    bathroom(f'{col}_LeftCommonBath', (68,748,205,881), z, col, mats)
    bathroom(f'{col}_RightCommonBath', (874,153,984,369), z, col, mats)
    bathroom(f'{col}_RightMasterBath', (1084,748,1255,881), z, col, mats)
