import math
from . import geometry as g
from .furniture import Assembly, plant, bathroom
from .materials import artwork_material, base_material, set_input
from .config import ROOT, xy, px_bounds


def modern_sofa(name,origin,rotation,col,mats):
    a=Assembly(name,origin,rotation,col)
    a.box('LowBase',(0,0,0.24),(2.95,0.96,0.25),mats['leather'],0.035,collider=True)
    a.box('LowBack',(0,0.38,0.61),(2.95,0.20,0.58),mats['leather'],0.035)
    for side in (-1,1):
        a.box(f'Arm{side}',(side*1.39,0,0.48),(0.18,0.98,0.48),mats['leather'],0.025)
    for i in range(3):
        x=(i-1)*0.89
        a.box(f'Seat{i}',(x,-0.08,0.43),(0.86,0.76,0.16),mats['leather'],0.025)
        a.box(f'BackPad{i}',(x,0.25,0.67),(0.86,0.14,0.40),mats['leather'],0.025)
    a.box('Chaise',(-0.95,-0.69,0.28),(1.0,0.82,0.28),mats['leather'],0.035,collider=True)
    a.box('ChaisePad',(-0.95,-0.69,0.45),(0.91,0.78,0.14),mats['leather'],0.025)
    for x in (-1.20,1.20):
        for y in (-0.30,0.30):
            a.cylinder(f'Foot{x}_{y}',(x,y,0.075),0.022,0.15,mats['chrome'],12)
    return a.root


def modern_armchair(name,origin,rotation,col,mats):
    a=Assembly(name,origin,rotation,col)
    a.box('Seat',(0,0,0.43),(0.83,0.82,0.22),mats['leather'],0.025,collider=True)
    a.box('Back',(0,0.32,0.74),(0.84,0.18,0.68),mats['leather'],0.025)
    for side in (-1,1):
        a.box(f'Arm{side}',(side*0.37,0,0.58),(0.13,0.82,0.42),mats['leather'],0.02)
        a.rod(f'Leg{side}',(side*0.31,0.25,0.34),(side*0.31,0.25,0.02),0.022,mats['chrome'])
    return a.root


def glass_table(name,origin,col,mats):
    a=Assembly(name,origin,0,col)
    a.box('GlassTop',(0,0,0.43),(1.35,0.78,0.025),mats['glass'],0.008)
    a.box('LowerShelf',(0,0,0.16),(1.12,0.62,0.022),mats['glass'],0.006)
    for x in (-0.62,0.62):
        for y in (-0.33,0.33):
            a.rod(f'Frame{x}_{y}',(x,y,0.44),(x,y,0.03),0.018,mats['black'])
    for y in (-0.33,0.33):
        a.rod(f'Edge{y}',(-0.62,y,0.43),(0.62,y,0.43),0.018,mats['black'])
    g.collision_box(name,(origin[0],origin[1],origin[2]+0.23),(1.35,0.78,0.46))
    a.box('Book',(0.27,0.05,0.47),(0.32,0.24,0.035),mats['modern_white'],0.005)
    a.cylinder('Cup',(-0.28,-0.08,0.51),0.055,0.11,mats['water'],16)
    return a.root


def dome(name,origin,col,mats,scale=1):
    a=Assembly(name,origin,0,col)
    a.rod('Cord',(0,0,0.48*scale),(0,0,0),0.009*scale,mats['black'],8)
    a.sphere('Dome',(0,0,-0.18*scale),(0.38*scale,0.38*scale,0.23*scale),mats['modern_white'],24,12)
    a.cylinder('Diffuser',(0,0,-0.36*scale),0.32*scale,0.018*scale,mats['light'],24)
    return a.root


def fireplace_tv(name,origin,rotation,col,mats):
    a=Assembly(name,origin,rotation,col)
    a.box('WhiteMonolith',(0,0.06,1.12),(2.10,0.22,2.18),mats['modern_white'],0.015,collider=True)
    a.box('TV',(0,-0.075,1.60),(1.62,0.055,0.94),mats['lacquer'],0.012)
    a.box('Screen',(0,-0.107,1.60),(1.56,0.012,0.88),mats['screen'],0.006)
    a.box('FireInset',(0,-0.09,0.58),(1.48,0.055,0.42),mats['lacquer'],0.008)
    fire,bsdf=base_material(f'{name}_Flame',(1,0.20,0.015,1),0.4)
    set_input(bsdf,'Emission Color',(1,0.12,0.005,1)); set_input(bsdf,'Emission Strength',5)
    for i in range(9):
        a.box(f'Flame{i}',(-0.60+i*0.15,-0.125,0.49+(i%3)*0.025),(0.09,0.015,0.12+(i%3)*0.05),fire,0.01)
    a.box('Hearth',(0,-0.18,0.32),(1.72,0.45,0.09),mats['modern_white'],0.015)
    return a.root


def modern_art(name,origin,rotation,col,mats,index=1):
    a=Assembly(name,origin,rotation,col)
    a.box('Frame',(0,0,0),(0.90,0.04,1.12),mats['lacquer'],0.008)
    art=artwork_material(f'{name}_Print',ROOT/'public'/'textures'/'art'/f'modern-{index%3+1}.jpg')
    a.box('Print',(0,-0.025,0),(0.84,0.009,1.06),art)
    return a.root


def slats(name,origin,rotation,col,mats,count=9):
    a=Assembly(name,origin,rotation,col)
    for i in range(count):
        a.box(f'Slat{i}',((i-(count-1)/2)*0.13,0,1.32),(0.045,0.14,2.64),mats['lacquer'],0.006)
    return a.root


def telescope(name,origin,col,mats):
    a=Assembly(name,origin,0,col)
    for i in range(3):
        angle=i*math.tau/3
        a.rod(f'Tripod{i}',(0,0,0.90),(math.cos(angle)*0.37,math.sin(angle)*0.37,0.03),0.018,mats['chrome'])
    a.rod('Mount',(0,0,0.82),(0,0,1.17),0.035,mats['chrome'])
    tube=a.cylinder('Tube',(0,0,1.25),0.085,0.68,mats['modern_white'],20,(0,math.pi/2-0.28,0.35))
    a.cylinder('Lens',(0.30,-0.11,1.34),0.095,0.045,mats['lacquer'],20,(0,math.pi/2-0.28,0.35))
    return a.root


def modern_living(side,z,col,mats):
    left=side=='Left'
    x0,y0,x1,y1=px_bounds((433,881,711,1180) if left else (711,881,984,1180))
    cx,cy=(x0+x1)/2,(y0+y1)/2
    modern_sofa(f'EDIT_{col}_{side}ModernSofa',(x1-0.58 if left else x0+0.58,cy,z),-math.pi/2 if left else math.pi/2,col,mats)
    modern_armchair(f'{col}_{side}_Chair',(cx+(-0.75 if left else 0.75),cy+0.90,z),math.pi/2 if left else -math.pi/2,col,mats)
    glass_table(f'{col}_{side}_GlassTable',(cx,cy-0.10,z),col,mats)
    fireplace_tv(f'{col}_{side}_FireplaceTV',(x0+0.18 if left else x1-0.18,cy,z),math.pi/2 if left else -math.pi/2,col,mats)
    modern_art(f'{col}_{side}_Abstract',(x1-0.10 if left else x0+0.10,cy,z+1.65),-math.pi/2 if left else math.pi/2,col,mats,1 if left else 3)
    slats(f'{col}_{side}_Slats',(cx+(1.30 if left else -1.30),y1-0.10,z),0,col,mats,8)
    plant(f'{col}_{side}_ModernPlant',(x0+0.48 if left else x1-0.48,y0+0.55,z),col,mats,1.0)
    telescope(f'{col}_{side}_Telescope',(cx,y0+0.48,z),col,mats)
    dome(f'{col}_{side}_Dome',(cx,cy,z+2.55),col,mats,1.0)
    g.box(f'{col}_{side}_CoolCove',(cx,y1-0.18,z+2.73),(x1-x0-0.35,0.03,0.03),mats['emit'],col)
    for xx in (-1.3,1.3):
        for yy in (-1.25,1.25):
            g.cylinder(f'{col}_{side}_Downlight{xx}_{yy}',(cx+xx,cy+yy,z+2.92),0.06,0.025,mats['light'],col,16)


def modern_chair(name,origin,rotation,col,mats):
    a=Assembly(name,origin,rotation,col)
    a.box('Seat',(0,0,0.48),(0.47,0.47,0.12),mats['gray_fabric'],0.025,collider=True)
    a.box('Back',(0,0.20,0.78),(0.47,0.10,0.57),mats['gray_fabric'],0.025)
    for x in (-0.18,0.18):
        for y in (-0.17,0.17):
            a.rod(f'Leg{x}_{y}',(x,y,0.43),(x,y,0.02),0.016,mats['black'])
    return a.root


def modern_dining(name,origin,col,mats):
    x,y,z=origin
    a=Assembly(f'{name}_Table',origin,0,col)
    a.box('BlackTop',(0,0,0.75),(1.85,0.92,0.075),mats['lacquer'],0.018,collider=True)
    for px in (-0.74,0.74):
        a.box(f'Leg{px}',(px,0,0.37),(0.075,0.74,0.72),mats['lacquer'],0.012)
    for i,px in enumerate((-0.58,0.58)):
        modern_chair(f'{name}_N{i}',(x+px,y+0.78,z),0,col,mats)
        modern_chair(f'{name}_S{i}',(x+px,y-0.78,z),math.pi,col,mats)
    modern_chair(f'{name}_E',(x+1.18,y,z),math.pi/2,col,mats)
    modern_chair(f'{name}_W',(x-1.18,y,z),-math.pi/2,col,mats)
    for i in (-1,0,1):
        dome(f'{name}_Pendant{i}',(x+i*0.48,y,z+2.35),col,mats,0.60)
    a.cylinder('Vase',(0,0,0.88),0.07,0.22,mats['chrome'],16)


def modern_kitchen(name,origin,rotation,col,mats,length=3.0):
    a=Assembly(name,origin,rotation,col)
    a.box('WhiteBase',(0,0,0.44),(length,0.64,0.86),mats['modern_white'],0.012,collider=True)
    a.box('BlackCounter',(0,0,0.91),(length+0.05,0.68,0.06),mats['lacquer'],0.012)
    count=max(4,round(length/.6))
    for i in range(count):
        x=-length/2+(i+.5)*length/count
        a.box(f'Door{i}',(x,-0.334,0.45),(length/count-.025,0.025,0.73),mats['modern_white'],0.006)
        a.box(f'Handle{i}',(x,-0.355,0.73),(0.19,0.015,0.012),mats['chrome'],0.003)
    a.box('BlackUpper',(0,0.12,1.95),(length*.72,0.38,0.72),mats['lacquer'],0.012)
    a.box('Hood',(-length*.20,0.04,1.55),(0.86,0.55,0.16),mats['chrome'],0.015)
    a.box('HoodStack',(-length*.20,0.13,2.05),(0.42,0.36,0.92),mats['lacquer'],0.012)
    a.box('Cooktop',(-length*.20,-0.04,0.95),(0.64,0.46,0.025),mats['screen'],0.01)
    a.box('Sink',(length*.24,-0.03,0.95),(0.62,0.42,0.025),mats['chrome'],0.025)
    a.box('Fridge',(-length/2-.43,0,1.02),(0.74,0.70,2.04),mats['lacquer'],0.025,collider=True)
    # Two compact bar stools at the open kitchen entrance.
    for i in (-1,1):
        stool=Assembly(f'{name}_BarStool{i}',a.world((i*.38,-0.92,0)),rotation,col)
        stool.cylinder('Seat',(0,0,0.70),0.20,0.09,mats['gray_fabric'],20)
        stool.rod('Stem',(0,0,0.67),(0,0,0.05),0.025,mats['chrome'])
        stool.cylinder('Base',(0,0,0.04),0.19,0.035,mats['chrome'],20)


def modern_bedroom(name,bounds,z,col,mats,double=True,master=False):
    x0,y0,x1,y1=px_bounds(bounds); cx,cy=(x0+x1)/2,(y0+y1)/2
    a=Assembly(f'EDIT_{col}_{name}_ModernBed' if master else f'{col}_{name}_ModernBed',(cx,cy-.15,z),0,col)
    width=1.8 if double else 1.2
    a.box('Platform',(0,0,0.20),(width+.16,2.20,0.26),mats['lacquer'],0.025,collider=True)
    a.box('Mattress',(0,0,0.42),(width,2.04,0.25),mats['gray_fabric'],0.055)
    a.box('Duvet',(0,-.30,0.58),(width+.02,1.40,0.12),mats['gray_fabric'],0.035)
    a.box('Headboard',(0,1.02,.72),(width+.20,.14,1.02),mats['leather'],0.025)
    for i in range(2 if double else 1):
        px=(i-.5)*.76 if double else 0
        a.box(f'Pillow{i}',(px,.64,.65),(.66,.42,.15),mats['modern_white'],.03)
    for side in (-1,1):
        a.box(f'Night{side}',(side*(width/2+.31),.68,.28),(.44,.42,.50),mats['lacquer'],.012,collider=True)
        a.cylinder(f'Lamp{side}',(side*(width/2+.31),.68,.67),.12,.24,mats['modern_white'],20)
    wardrobe=Assembly(f'{col}_{name}_BlackWardrobe',(x1-.38,cy-.10,z),math.pi/2,col)
    wardrobe.box('Cabinet',(0,0,1.10),(min(1.8,y1-y0-.5),.60,2.20),mats['lacquer'],.012,collider=True)
    modern_art(f'{col}_{name}_Art',(x0+.08,cy,z+1.55),math.pi/2,col,mats,2)
    g.cylinder(f'{col}_{name}_CeilingPanel',(cx,cy,z+2.91),.25,.055,mats['light'],col,24)


def build_modern_interior(floor,mats):
    col=f'F{floor:02d}'; z=3.6+(floor-2)*3
    modern_living('Left',z,col,mats); modern_living('Right',z,col,mats)
    modern_dining(f'{col}_LeftModernDining',(*xy(440,680),z),col,mats)
    modern_dining(f'{col}_RightModernDining',(*xy(830,680),z),col,mats)
    modern_kitchen(f'{col}_LeftModernKitchen',(*xy(335,1030),z),math.pi/2,col,mats,2.55)
    modern_kitchen(f'{col}_RightModernKitchen',(*xy(745,315),z),math.pi/2,col,mats,3.25)
    modern_bedroom('LeftMaster',(68,153,295,470),z,col,mats,True,True)
    modern_bedroom('LeftNorth',(295,240,540,470),z,col,mats,False)
    modern_bedroom('LeftSouth',(68,881,295,1180),z,col,mats,False)
    modern_bedroom('RightNorth',(984,240,1255,470),z,col,mats,False)
    modern_bedroom('RightMiddle',(984,470,1255,748),z,col,mats,False)
    modern_bedroom('RightMaster',(984,881,1255,1180),z,col,mats,True,True)
    bathroom(f'{col}_LeftMasterBath',(68,470,205,650),z,col,mats)
    bathroom(f'{col}_LeftCommonBath',(68,748,205,881),z,col,mats)
    bathroom(f'{col}_RightCommonBath',(874,153,984,369),z,col,mats)
    bathroom(f'{col}_RightMasterBath',(1084,748,1255,881),z,col,mats)
