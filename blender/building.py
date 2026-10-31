import bpy
import math
from mathutils import Vector
from . import geometry as g
from .config import WIDTH, DEPTH, WALL_EXT, WALL_INT, FLOOR_Z, ROOMS, STAIR_PX, ELEVATOR_PX, xy, px_bounds
from .furniture import Assembly, sofa, armchair, coffee_table, plant, chandelier, flowers


def rect(name, bounds, z, thickness, mat, col, collision=False, uv_scale=2.0, edge_inset=0.035):
    x0,y0,x1,y1 = px_bounds(bounds) if len(bounds)==4 and max(bounds)>20 else bounds
    # Keep horizontal slabs just inside the facade to avoid coplanar exterior z-fighting.
    x0=max(x0,-WIDTH/2+edge_inset); x1=min(x1,WIDTH/2-edge_inset)
    y0=max(y0,-DEPTH/2+edge_inset); y1=min(y1,DEPTH/2-edge_inset)
    return g.box(name, ((x0+x1)/2,(y0+y1)/2,z-thickness/2), (x1-x0,y1-y0,thickness), mat, col, collider=collision, uv_scale=uv_scale)


def window(name, center, width, height, bottom, rotation, col, mats, mullions=1, sliding=False):
    a = Assembly(name, (center[0],center[1],center[2]+bottom), rotation, col)
    frame = mats['metal']
    for x in (-width/2,width/2):
        a.box(f'Jamb{x}', (x,0,height/2), (0.065,0.11,height+0.08), frame, 0.008)
    for z in (0,height):
        a.box(f'Rail{z}', (0,0,z), (width+0.08,0.11,0.065), frame, 0.008)
    a.box('Glass', (0,0.012,height/2), (width-0.10,0.018,height-0.10), mats['glass'])
    for i in range(mullions):
        x = -width/2 + (i+1)*width/(mullions+1)
        a.box(f'Mullion{i}', (x,-0.005,height/2), (0.045,0.09,height), frame, 0.006)
    if sliding:
        a.box('SlidingHandle', (width*0.20,-0.075,height*0.45), (0.025,0.035,0.22), mats['gold'], 0.006)
    a.box('Sill', (0,0,-0.035), (width+0.20,0.20,0.07), mats['marble'], 0.015)
    return a.root


def door(name, center, width, height, rotation, col, mats, glass=False, modern=False):
    a = Assembly(name, center, rotation, col)
    frame_mat = mats['modern_white'] if modern else mats['white']
    for x in (-width/2,width/2):
        a.box(f'Architrave{x}', (x,0,height/2), (0.085,0.15,height+0.04), frame_mat, 0.012)
        if not modern:
            a.box(f'OuterMolding{x}', (x+(-0.055 if x<0 else 0.055),-0.015,height/2), (0.025,0.17,height+0.10), frame_mat, 0.008)
    a.box('Header', (0,0,height), (width+0.17,0.15,0.085), frame_mat, 0.012)
    if not modern:
        a.box('HeaderMolding', (0,-0.015,height+0.065), (width+0.25,0.17,0.035), frame_mat, 0.008)
    # A 78-degree open leaf keeps the passage visibly and physically open.
    hinge = Assembly(f'{name}_OpenLeaf', a.world((-width/2,0,0)), rotation+math.radians(78), col)
    leaf_mat = mats['glass'] if glass else mats['lacquer'] if modern else mats['white']
    hinge.box('Leaf', (width/2,0,height/2), (width-0.06,0.045,height-0.05), leaf_mat, 0.015)
    if not glass and not modern:
        for z in (0.58,1.48):
            hinge.box(f'Panel{z}', (width/2,-0.028,z), (width-0.22,0.018,0.62), mats['cream'], 0.012)
    hinge.sphere('Handle', (width-0.15,-0.055,1.00), (0.035,0.035,0.035), mats['chrome'] if modern else mats['gold'], 12, 6)
    return a.root


def wainscot(name, p1, p2, z, col, mats, side=1):
    a,b = Vector(p1),Vector(p2)
    delta = b-a
    length = delta.length
    if length < 0.2:
        return
    direction = delta.normalized()
    normal = Vector((-direction.y,direction.x))*side
    center = (a+b)/2 + normal*0.078
    angle = math.atan2(direction.y,direction.x)
    def strip(suffix,h,height,depth=0.026):
        return g.box(f'{name}_{suffix}', (center.x,center.y,z+h), (length,depth,height), mats['white'], col, rotation=(0,0,angle))
    strip('Base',0.09,0.18,0.035)
    strip('ChairRail',1.08,0.075,0.045)
    strip('LowerRail',0.25,0.035)
    count = max(1,round(length/0.78))
    for i in range(count+1):
        p = a + delta*(i/count) + normal*0.079
        g.box(f'{name}_Stile{i}', (p.x,p.y,z+0.66), (0.038,0.032,0.78), mats['white'], col, rotation=(0,0,angle))
    # Upper wall restrained American-style rectangular molding.
    for i in range(count):
        p = a + delta*((i+0.5)/count) + normal*0.075
        panel_w = length/count-0.16
        if panel_w < 0.18:
            continue
        for h in (1.48,2.40):
            g.box(f'{name}_UpperH{i}_{h}', (p.x,p.y,z+h), (panel_w,0.022,0.022), mats['white'], col, rotation=(0,0,angle))
        for sign in (-1,1):
            q = p + direction*(sign*panel_w/2)
            g.box(f'{name}_UpperV{i}_{sign}', (q.x,q.y,z+1.94), (0.022,0.022,0.92), mats['white'], col, rotation=(0,0,angle))


def build_structural_floor(floor, mats):
    col = f'F{floor:02d}'
    z = FLOOR_Z[floor]
    regions = [(68,153,540,1180),(710,153,1255,1180),(540,505,710,577),(540,754,710,1180)]
    for i,bounds in enumerate(regions):
        rect(f'{col}_StructuralSlab{i}', bounds, z, 0.24, mats['concrete'], col, collision=True)
    if floor == 1:
        for i,bounds in enumerate(regions):
            rect(f'F01_LobbyMarble{i}', bounds, z+0.035, 0.035, mats['marble'], col, uv_scale=1.5)
        return
    floor_regions = [
        (68,153,295,470),(295,240,540,470),(68,881,295,1180),
        (295,470,540,881),(433,881,711,1180),(540,754,711,881),
        (984,240,1255,748),(984,881,1255,1180),(710,470,984,1180),
        (205,470,295,650),(205,748,295,881),
    ]
    floor_material = mats['floor'] if floor==6 else mats['marble']
    for i,bounds in enumerate(floor_regions):
        rect(f'{col}_{"IvoryInlayMarble" if floor==6 else "ModernPolishedTile"}{i}', bounds, z+0.035, 0.035, floor_material, col, uv_scale=2.2 if floor==6 else 1.6)
    tile = [(295,881,433,1180),(710,153,874,470),(68,470,205,650),(68,748,205,881),
            (874,153,984,369),(1084,748,1255,881),(540,505,710,577)]
    for i,bounds in enumerate(tile):
        rect(f'{col}_StoneFloor{i}', bounds, z+0.04, 0.04, mats['marble'], col, uv_scale=1.5)
    for i,bounds in enumerate([(295,153,540,240),(984,153,1255,240)]):
        rect(f'{col}_BalconyTile{i}', bounds, z+0.045, 0.045, mats['paving'], col, uv_scale=1.2)


def build_outer_shell(floor, mats):
    z = FLOOR_Z[floor]
    height = 3.6 if floor == 1 else 3.0
    col = 'SHELL'
    ox,oy = 8.6-WALL_EXT/2,7.45-WALL_EXT/2
    walls = [
        ('South',(-ox,-oy),(ox,-oy),[
            (0.105,1.8,0.9,1.8),(0.235,1.0,0.9,1.8),(0.37,2.4,0.15,2.4),
            (0.63,2.4,0.15,2.4),(0.87,2.4,0.15,2.4)]),
        ('North',(-ox,oy),(ox,oy),[
            (0.105,1.8,0.9,1.8),(0.285,2.1,0,2.1),(0.47,1.2,0.9,1.8),
            (0.61,1.2,0.9,1.8),(0.87,2.4,0,2.1)]),
        ('West',(-ox,-oy),(-ox,oy),[(0.17,1.8,0.9,1.8),(0.49,1.0,1.1,1.5),(0.83,1.8,0.9,1.8)]),
        ('East',(ox,-oy),(ox,oy),[(0.17,2.4,0.15,2.4),(0.50,1.8,0.9,1.8),(0.83,1.8,0.9,1.8)]),
    ]
    if floor == 1:
        walls[0] = ('South',(-ox,-oy),(ox,-oy),[
            (0.105,2.4,0.3,2.7),(0.235,2.0,0.3,2.7),(0.37,3.0,0,3.0),
            (0.63,3.0,0,3.0),(0.87,2.4,0.3,2.7)])
    for name,p1,p2,openings in walls:
        g.wall(f'{name}_F{floor}',p1,p2,z,height,WALL_EXT,mats['wall_ext'],col,openings)
        a,b = Vector(p1),Vector(p2)
        angle = math.atan2((b-a).y,(b-a).x)
        for i,(t,w,bottom,h) in enumerate(openings):
            center = a+(b-a)*t
            if floor == 1 and name=='South' and i in (2,3):
                # Two open lobby entrances; slim side panels retain the facade rhythm.
                door(f'LobbyEntrance{i}', (center.x,center.y,z), w, h, angle, col, mats, glass=True)
            else:
                window(f'{name}_F{floor}_Window{i}', (center.x,center.y,z), w,h,bottom,angle,col,mats,2 if w>2 else 1,bottom==0)
    # Floor bands stay inside the 17.2 x 14.9 m envelope.
    for zz in (z+0.10,z+height-0.10):
        g.box(f'FacadeBandS_{floor}_{zz}', (0,-7.32,zz), (17.2,0.10,0.12), mats['marble'], col)
        g.box(f'FacadeBandN_{floor}_{zz}', (0,7.32,zz), (17.2,0.10,0.12), mats['marble'], col)
        g.box(f'FacadeBandW_{floor}_{zz}', (-8.47,0,zz), (0.10,14.7,0.12), mats['marble'], col)
        g.box(f'FacadeBandE_{floor}_{zz}', (8.47,0,zz), (0.10,14.7,0.12), mats['marble'], col)


def curtains_for_floor(floor,mats):
    col=f'F{floor:02d}'; z=FLOOR_Z[floor]
    ox,oy=8.6-WALL_EXT/2,7.45-WALL_EXT/2
    specs=[
        ('South',(-ox,-oy),(ox,-oy),(0,-1),[.105,.235,.37,.63,.87]),
        ('North',(-ox,oy),(ox,oy),(0,1),[.105,.285,.47,.61,.87]),
        ('West',(-ox,-oy),(-ox,oy),(-1,0),[.17,.49,.83]),
        ('East',(ox,-oy),(ox,oy),(1,0),[.17,.50,.83]),
    ]
    for name,p1,p2,outward,positions in specs:
        a,b=Vector(p1),Vector(p2); delta=b-a
        normal=Vector((-outward[0],-outward[1]))*.17
        angle=math.atan2(delta.y,delta.x)
        for i,t in enumerate(positions):
            center=a+delta*t+normal
            width=2.25 if t in (.37,.63,.87) else 1.55
            if floor<6:
                g.box(f'{col}_{name}_Roller{i}',(center.x,center.y,z+2.61),(width,.13,.42),mats['roller'],col,rotation=(0,0,angle))
                if name=='South':
                    for side in (-1,1):
                        p=center+delta.normalized()*(side*width*.43)
                        g.curtain(f'{col}_{name}_BlackSide{i}_{side}',(p.x,p.y,z+1.35),.34,2.60,mats['roller'],col,angle,4,12)
            else:
                g.curtain(f'{col}_{name}_Sheer{i}',(center.x,center.y,z+1.35),width*.88,2.58,mats['sheer'],col,angle,8,20)
                for side in (-1,1):
                    p=center+delta.normalized()*(side*width*.39)
                    g.curtain(f'{col}_{name}_Drape{i}_{side}',(p.x-normal.x*.035,p.y-normal.y*.035,z+1.35),width*.27,2.62,mats['fabric'],col,angle,5,18)
            start=a+delta*max(0,t-width/delta.length/2)+normal
            end=a+delta*min(1,t+width/delta.length/2)+normal
            g.cylinder_between(f'{col}_{name}_CurtainRod{i}',(start.x,start.y,z+2.72),(end.x,end.y,z+2.72),.018,mats['metal'],col,10)


def interior_walls(floor, mats):
    col = f'F{floor:02d}'
    z = FLOOR_Z[floor]
    h = 3.0
    specs = [
        ('LeftMasterSouth',(68,470),(295,470),[(0.72,0.9,0,2.1)]),
        ('LeftMasterEast',(295,153),(295,470),[]),
        ('LeftNorthSouth',(295,470),(540,470),[(0.16,0.9,0,2.1)]),
        ('LeftBalconyDoor',(295,240),(540,240),[(0.50,2.1,0,2.1)]),
        ('LeftServiceEast',(295,470),(295,881),[(0.43,0.9,0,2.1)]),
        ('LeftMasterBathEast',(205,470),(205,650),[(0.50,0.8,0,2.1)]),
        ('LeftLightwellNorth',(68,650),(295,650),[(0.73,1.0,0.9,1.5)]),
        ('LeftCommonBathNorth',(68,748),(205,748),[]),
        ('LeftCommonBathEast',(205,748),(205,881),[(0.50,0.8,0,2.1)]),
        ('LeftSouthBedNorth',(68,881),(295,881),[(0.76,0.9,0,2.1)]),
        ('LeftKitchenNorth',(295,881),(433,881),[(0.22,0.9,0,2.1)]),
        ('LeftKitchenEast',(433,881),(433,1180),[]),
        ('StairWest',(540,153),(540,505),[]),
        ('StairEast',(710,153),(710,505),[]),
        ('StairSouth',(540,505),(710,505),[(0.50,1.0,0,2.1)]),
        ('LeftEntry',(540,505),(540,577),[(0.50,0.9,0,2.1)]),
        ('ElevatorWest',(533,577),(533,754),[]),
        ('ElevatorNorth',(533,577),(710,577),[]),
        ('ElevatorEast',(710,577),(710,754),[]),
        ('ElevatorSouth',(533,754),(710,754),[(0.50,1.10,0,2.2)]),
        ('RightEntry',(710,505),(710,577),[(0.50,0.9,0,2.1)]),
        ('RightKitchenEast',(874,153),(874,470),[]),
        ('RightKitchenSouth',(710,470),(874,470),[(0.20,0.9,0,2.1)]),
        ('RightBathSouth',(874,369),(984,369),[(0.50,0.8,0,2.1)]),
        ('RightBathEast',(984,153),(984,369),[]),
        ('RightBalconyDoor',(984,240),(1255,240),[(0.50,2.4,0,2.1)]),
        ('RightNorthWest',(984,240),(984,470),[(0.70,0.9,0,2.1)]),
        ('RightNorthSouth',(984,470),(1255,470),[]),
        ('RightMiddleWest',(984,470),(984,748),[(0.56,0.9,0,2.1)]),
        ('RightMiddleSouth',(984,748),(1255,748),[]),
        ('RightMasterEntry',(984,748),(984,881),[(0.50,0.9,0,2.1)]),
        ('RightMasterBathWest',(1084,748),(1084,881),[(0.50,0.8,0,2.1)]),
        ('RightMasterBathSouth',(1084,881),(1255,881),[]),
        ('RightMasterNorth',(984,881),(1084,881),[]),
        ('RightMasterWest',(984,881),(984,1180),[]),
        ('UnitDivider',(710,754),(710,1180),[]),
    ]
    for name,p1px,p2px,openings in specs:
        p1,p2 = xy(*p1px),xy(*p2px)
        # Interior partitions terminate at the inner facade face, never at the outer surface.
        p1=(max(-WIDTH/2+WALL_EXT,min(WIDTH/2-WALL_EXT,p1[0])),max(-DEPTH/2+WALL_EXT,min(DEPTH/2-WALL_EXT,p1[1])))
        p2=(max(-WIDTH/2+WALL_EXT,min(WIDTH/2-WALL_EXT,p2[0])),max(-DEPTH/2+WALL_EXT,min(DEPTH/2-WALL_EXT,p2[1])))
        g.wall(f'{col}_{name}',p1,p2,z,h,WALL_INT,mats['plaster'],col,openings)
        a,b = Vector(p1),Vector(p2)
        angle = math.atan2((b-a).y,(b-a).x)
        for i,(t,w,bottom,oh) in enumerate(openings):
            center = a+(b-a)*t
            if bottom == 0:
                door(f'{col}_{name}_Door{i}', (center.x,center.y,z), w,oh,angle,col,mats,glass='Balcony' in name,modern=floor<6)
            else:
                window(f'{col}_{name}_Window{i}', (center.x,center.y,z), w,oh,bottom,angle,col,mats)
    # Bathroom stone wall cladding, offset from structural walls.
    for room in ('left_master_bath','left_common_bath','right_common_bath','right_master_bath'):
        x0,y0,x1,y1 = px_bounds(ROOMS[room])
        g.box(f'{col}_{room}_TileNorth', ((x0+x1)/2,y1-0.045,z+1.45), (x1-x0-0.10,0.025,2.85), mats['marble'], col, uv_scale=1.4)
        g.box(f'{col}_{room}_TileWest', (x0+0.045,(y0+y1)/2,z+1.45), (0.025,y1-y0-0.10,2.85), mats['marble'], col, uv_scale=1.4)
    # Applied American wainscoting belongs exclusively to 6F; GTA floors stay minimal.
    if floor==6:
        for name,p1,p2,side in [
            ('LeftLivingSouth',(433,1180),(711,1180),-1),('RightLivingSouth',(711,1180),(984,1180),-1),
            ('LeftLivingWest',(433,881),(433,1180),1),('RightLivingEast',(984,881),(984,1180),-1),
            ('LeftDiningCore',(540,650),(540,881),-1),('RightDiningBed',(984,470),(984,748),1),
        ]:
            wainscot(f'{col}_{name}',xy(*p1),xy(*p2),z,col,mats,side)
    for i,bounds in enumerate([(68,153,540,1180),(710,153,1255,1180),(540,754,710,1180)]):
        rect(f'{col}_Ceiling{i}',bounds,z+3.02,0.08,mats['white'] if floor==6 else mats['modern_white'],col)
    curtains_for_floor(floor,mats)


def ramp(name, x, y0, y1, width, z0, z1):
    verts = [(x-width/2,y0,z0),(x+width/2,y0,z0),(x+width/2,y1,z1),(x-width/2,y1,z1),
             (x-width/2,y0,z0-0.18),(x+width/2,y0,z0-0.18),(x+width/2,y1,z1-0.18),(x-width/2,y1,z1-0.18)]
    faces = [(0,1,2,3),(4,7,6,5),(0,4,5,1),(1,5,6,2),(2,6,7,3),(3,7,4,0)]
    obj = g.mesh_object(f'COL_{name}',verts,faces,None,'COLLISION')
    obj.hide_render = True
    obj.display_type = 'WIRE'
    obj['collision'] = True
    return obj


def stairs(floor, mats):
    col = 'CORE'
    z = FLOOR_Z[floor]
    height = 3.6 if floor == 1 else 3.0
    x0,y0,x1,y1 = px_bounds(STAIR_PX)
    width = x1-x0
    start = y0+0.38
    run = min(2.85,(y1-y0)-1.55)
    end = start+run
    count = 10 if floor == 1 else 9
    rise = height/(count*2)
    depth = run/count
    centers = (x0+width*0.27,x0+width*0.73)
    flight_width = width*0.42
    for flight in range(2):
        for i in range(count):
            top = z + (i+1)*rise + flight*height/2
            y = start+(i+0.5)*depth if flight==0 else end-(i+0.5)*depth
            g.box(f'F{floor}_Stair{flight}_Step{i}', (centers[flight],y,top-0.075), (flight_width,depth+0.012,0.15), mats['concrete'], col)
            g.box(f'F{floor}_Stair{flight}_Tread{i}', (centers[flight],y-0.01 if flight==0 else y+0.01,top+0.012), (flight_width,depth+0.02,0.025), mats['marble'], col)
        for side in (-1,1):
            x = centers[flight]+side*(flight_width/2-0.04)
            low = (x,start,z+0.90) if flight==0 else (x,end,z+height/2+0.90)
            high = (x,end,z+height/2+0.90) if flight==0 else (x,start,z+height+0.90)
            g.cylinder_between(f'F{floor}_Stair{flight}_Handrail{side}',low,high,0.028,mats['wood'],col,12)
            for i in range(0,count+1,3):
                t = i/count
                y = start+run*t if flight==0 else end-run*t
                zz = z+height/2*flight+(height/2)*t
                g.cylinder_between(f'F{floor}_Stair{flight}_Post{side}_{i}',(x,y,zz),(x,y,zz+0.90),0.018,mats['metal'],col,10)
    ramp(f'F{floor}_LowerFlight',centers[0],start,end,flight_width,z,z+height/2)
    ramp(f'F{floor}_UpperFlight',centers[1],start,end,flight_width,z+height,z+height/2)
    landing_depth = y1-end
    g.box(f'F{floor}_MidLanding', ((x0+x1)/2,end+landing_depth/2,z+height/2-0.10), (width,landing_depth,0.20), mats['concrete'], col, collider=True)
    g.box(f'F{floor}_MidLandingTile', ((x0+x1)/2,end+landing_depth/2,z+height/2+0.015), (width,landing_depth,0.03), mats['marble'], col)
    g.box(f'F{floor}_TopLanding', ((x0+x1)/2,y0+0.19,z+height-0.10), (width,0.38,0.20), mats['concrete'], col, collider=True)
    g.box(f'F{floor}_TopLandingTile', ((x0+x1)/2,y0+0.19,z+height+0.015), (width,0.38,0.03), mats['marble'], col)


def elevator(floor, mats):
    col = 'CORE'
    z = FLOOR_Z[floor]
    x0,y0,x1,y1 = px_bounds(ELEVATOR_PX)
    cx,cy = (x0+x1)/2,(y0+y1)/2
    g.box(f'F{floor}_ElevatorFloor', (cx,cy,z-0.08), (x1-x0,y1-y0,0.16), mats['metal'], col, collider=True)
    g.box(f'F{floor}_ElevatorBack', (cx,y1-0.10,z+1.20), (x1-x0-0.15,0.08,2.40), mats['metal'], col)
    g.box(f'F{floor}_ElevatorCeiling', (cx,cy,z+2.55), (x1-x0, y1-y0,0.10), mats['metal'], col)
    g.box(f'F{floor}_ElevatorLight', (cx,cy,z+2.48), (0.85,0.65,0.025), mats['light'], col)
    # Door panels are parked open; UI teleport is the simulated elevator travel.
    for side in (-1,1):
        g.box(f'F{floor}_ElevatorDoor{side}', (cx+side*0.65,y0+0.04,z+1.10), (0.40,0.055,2.20), mats['metal'], col, bevel_width=0.015)
        g.box(f'F{floor}_ElevatorDoorTrim{side}', (cx+side*0.65,y0-0.005,z+1.10), (0.018,0.025,2.05), mats['gold'], col)


def balcony_rails(floor, mats):
    z = FLOOR_Z[floor]
    col = 'SHELL'
    for index,bounds in enumerate([(295,153,540,240),(984,153,1255,240)]):
        x0,y0,x1,y1 = px_bounds(bounds)
        for x in (x0+0.08,x1-0.08):
            g.box(f'F{floor}_Balcony{index}_Side{x}', (x,(y0+y1)/2,z+0.55), (0.045,y1-y0,1.10), mats['glass'], col)
            g.cylinder_between(f'F{floor}_Balcony{index}_Rail{x}', (x,y0,z+1.10),(x,y1,z+1.10),0.025,mats['metal'],col)


def build_lobby(mats):
    col,z = 'F01',0.0
    # Lobby seating stays south of the core, with an unobstructed entrance path.
    sofa('F01_LobbySofa', (-3.3,-3.1,z), 0, col,mats)
    armchair('F01_LobbyChairL',(-4.8,-4.2,z),math.pi/2,col,mats)
    armchair('F01_LobbyChairR',(-1.8,-4.2,z),-math.pi/2,col,mats)
    coffee_table('F01_LobbyTable',(-3.3,-4.25,z),col,mats)
    chandelier('F01_LobbyChandelier',(-3.3,-3.8,3.05),col,mats,1.5)
    plant('F01_LobbyPlantL',(-7.6,-6.3,z),col,mats,1.3)
    plant('F01_LobbyPlantR',(6.9,-6.3,z),col,mats,1.3)
    a = Assembly('F01_Mailboxes',(5.8,1.0,0),math.pi/2,col)
    a.box('Cabinet',(0,0,1.15),(3.4,0.35,2.1),mats['wood'],0.025,collider=True)
    for i in range(8):
        for j in range(3):
            a.box(f'Box{i}_{j}',(-1.47+i*0.42,-0.19,0.55+j*0.55),(0.38,0.025,0.49),mats['gold'],0.009)
    for x in (-7.0,-3.0,2.0,6.0):
        g.cylinder(f'F01_Downlight{x}',(x,-2.5,3.42),0.12,0.035,mats['light'],col,20)


def build_roof(mats):
    z = 18.6
    rect('ROOF_MainSlab',(-8.6,-7.45,8.6,7.45),z,0.24,mats['concrete'],'ROOF',collision=True)
    rect('ROOF_Membrane',(-8.45,-7.30,8.45,7.30),z+0.04,0.04,mats['roof'],'ROOF')
    ox,oy=8.6-0.09,7.45-0.09
    for name,p1,p2 in [('S',(-ox,-oy),(ox,-oy)),('N',(-ox,oy),(ox,oy)),('W',(-ox,-oy),(-ox,oy)),('E',(ox,-oy),(ox,oy))]:
        g.wall(f'ROOF_Parapet{name}',p1,p2,z,0.55,0.18,mats['wall_ext'],'ROOF')
    g.box('ROOF_StairBulkhead',(-0.55,5.15,19.25),(2.65,3.4,1.3),mats['wall_ext'],'ROOF',collider=True)
    g.box('ROOF_BulkheadCap',(-0.55,5.15,19.94),(2.75,3.5,0.12),mats['marble'],'ROOF')


def build_site(mats):
    g.box('SITE_Ground',(0,0,-0.32),(72,72,0.50),mats['grass'],'SITE',collider=True)
    g.box('SITE_Paving',(0,0,-0.035),(22,19,0.07),mats['paving'],'SITE',collider=True,uv_scale=2.0)
    g.box('SITE_SouthWalk',(0,-12.0,-0.015),(48,3.0,0.10),mats['paving'],'SITE',collider=True,uv_scale=2.0)
    g.box('SITE_EastWalk',(13.5,0,-0.015),(3.0,38,0.10),mats['paving'],'SITE',collider=True,uv_scale=2.0)
    for x in (-9.8,9.8):
        for y in (-5.8,0,5.8):
            g.box(f'SITE_Planter{x}_{y}',(x,y,0.20),(1.1,2.3,0.42),mats['marble'],'SITE',bevel_width=0.05,collider=True)
            g.box(f'SITE_Soil{x}_{y}',(x,y,0.425),(0.98,2.18,0.04),mats['soil'],'SITE')
            for j in range(3):
                g.ico(f'SITE_Shrub{x}_{y}_{j}',(x,y-0.72+j*0.72,0.72),(0.48,0.48,0.48),mats['leaf'],'SITE',2)
    # Real-time botanical trees are added by the Three.js environment, not duplicated here.
    # Low-cost neighborhood massing prevents an empty horizon.
    for i,(x,w,d,h) in enumerate([(-27,12,14,10),(27,13,15,12),(-8,14,12,9),(14,15,12,11)]):
        y = 30 if i<2 else -31
        g.box(f'SITE_Context{i}',(x,y,h/2-0.05),(w,d,h),mats['wall_ext'],'SITE')
        for floor in range(max(2,int(h/3))):
            for col in range(3):
                g.box(f'SITE_Context{i}_Window{floor}_{col}',(x-w/3+col*w/3,y-d/2-0.015,1.6+floor*2.8),(1.3,0.03,1.5),mats['glass'],'SITE')


def build_building(mats):
    for floor in range(1,7):
        build_structural_floor(floor,mats)
        build_outer_shell(floor,mats)
        stairs(floor,mats)
        elevator(floor,mats)
        if floor >= 2:
            interior_walls(floor,mats)
            balcony_rails(floor,mats)
    build_lobby(mats)
    build_roof(mats)
    build_site(mats)
