import json,glob,os,math,collections,statistics
BASE=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUUID='188dee22-18d6-5752-ba7f-b69cf3d2506e'
def ids():
    return sorted(os.path.basename(p)[:-5] for p in glob.glob(BASE+'/tls/*.json'))
def load(i):
    return json.load(open(BASE+'/games/%s.json'%i)), json.load(open(BASE+'/tls/%s.json'%i))
def uv(x,y): return ((x+y)/2.0,(y-x)/2.0)
CENTER_U=7420.0
LANES={
 'TOP':[(1500,1800),(1169,4287),(1512,6699),(981,10441),(1600,12900),(4318,13875),(7943,13411),(10481,13650),(12800,12900)],
 'MID':[(1962,2038),(3651,3696),(5048,4812),(5846,6396),(8955,8510),(9767,10113),(11134,11207),(12843,12836)],
 'BOT':[(1800,1500),(4281,1253),(6919,1483),(10504,1029),(12900,1600),(13866,4505),(13327,8226),(13624,10572),(12900,12800)],
}
def _seg_dist(p,a,b):
    px,py=p;ax,ay=a;bx,by=b
    dx,dy=bx-ax,by-ay
    L=dx*dx+dy*dy
    t=0.0 if L==0 else max(0.0,min(1.0,((px-ax)*dx+(py-ay)*dy)/L))
    return math.hypot(px-(ax+t*dx),py-(ay+t*dy))
def lane_dist(x,y,lane):
    pts=LANES[lane]
    return min(_seg_dist((x,y),pts[i],pts[i+1]) for i in range(len(pts)-1))
def nearest_lane(x,y):
    d={l:lane_dist(x,y,l) for l in LANES}
    l=min(d,key=d.get); return l,d[l]
def me(g):
    for p,i in zip(g['participants'],g['participantIdentities']):
        if i['player']['puuid']==PUUID: return p['participantId']
    return None
def team_of(pid): return 100 if pid<=5 else 200

SMITE=11
def infer_roles(g,tl,lo=2.0,hi=9.5):
    """returns {pid: role} role in TOP,JGL,MID,ADC,SUP ; plus diagnostics"""
    import statistics as _s
    d=collections.defaultdict(lambda: collections.defaultdict(list))
    n=0
    for fr in tl['frames']:
        m=fr['timestamp']/60000.0
        if not (lo<=m<=hi): continue
        n+=1
        for k,p in fr['participantFrames'].items():
            pid=int(k);x,y=p['position']['x'],p['position']['y']
            for L in LANES: d[pid][L].append(lane_dist(x,y,L))
    med={pid:{L:_s.median(v) for L,v in dd.items()} for pid,dd in d.items()}
    st={p['participantId']:p['stats'] for p in g['participants']}
    spells={p['participantId']:(p['spell1Id'],p['spell2Id']) for p in g['participants']}
    roles={};diag={}
    for team in (100,200):
        pids=[p for p in range(1,11) if team_of(p)==team]
        jg=[p for p in pids if SMITE in spells[p]]
        jgl=jg[0] if len(jg)==1 else max(pids,key=lambda p: st[p]['neutralMinionsKilled'])
        roles[jgl]='JGL'
        rest=[p for p in pids if p!=jgl]
        # assign TOP and MID by lowest median distance, greedy on best margin
        assign={}
        avail=set(rest)
        for L in ('TOP','MID'):
            best=min(avail,key=lambda p: med[p][L])
            assign[L]=best; avail.discard(best)
        roles[assign['TOP']]='TOP'; roles[assign['MID']]='MID'
        bot=sorted(avail,key=lambda p:-st[p]['totalMinionsKilled'])
        roles[bot[0]]='ADC'; roles[bot[1]]='SUP'
        diag[team]={'jgl_by_smite':len(jg)==1,'frames':n,
                    'top_margin':med[assign['MID']]['TOP']-med[assign['TOP']]['TOP'],
                    'bot_cs_gap':st[bot[0]]['totalMinionsKilled']-st[bot[1]]['totalMinionsKilled']}
    return roles,med,diag

# ---- zones ----
NEXUS={100:(1962,2038),200:(12843,12836)}
LANE_HALF_WIDTH=1100.0
RIVER_HALF_U=900.0
BASE_RADIUS=2600.0
PITS={'DRAGON':(9973,4578),'BARON':(5012,10470),'HERALD':(4900,10200),'GRUBS':(4835,10233),
      'SCUTTLE_BOT':(10500,5000),'SCUTTLE_TOP':(4400,9900)}
def zone(x,y,my_team):
    u,v=uv(x,y)
    for t,(nx,ny) in NEXUS.items():
        if math.hypot(x-nx,y-ny)<BASE_RADIUS:
            return ('OWN_BASE' if t==my_team else 'ENEMY_BASE')
    if math.hypot(x-PITS['DRAGON'][0],y-PITS['DRAGON'][1])<1100: return 'DRAGON_PIT'
    if math.hypot(x-PITS['BARON'][0],y-PITS['BARON'][1])<1100: return 'BARON_PIT'
    L,d=nearest_lane(x,y)
    if d<LANE_HALF_WIDTH: return 'LANE_'+L
    half_blue = u<CENTER_U
    own = (half_blue and my_team==100) or ((not half_blue) and my_team==200)
    side='TOP' if v>0 else 'BOT'
    if abs(u-CENTER_U)<RIVER_HALF_U and abs(v)<4200: return 'RIVER_'+side
    return ('OWN_JUNGLE_' if own else 'ENEMY_JUNGLE_')+side
NEUTRAL_U=900.0
def side_half(x,y,my_team):
    u,_=uv(x,y)
    if abs(u-CENTER_U)<NEUTRAL_U: return 'NEUTRAL'
    return 'OWN' if ((u<CENTER_U)==(my_team==100)) else 'ENEMY'

def interp_pos(F,pid,t):
    k=str(pid)
    prev=None;nxt=None
    for f in F:
        if k not in f['participantFrames']: continue
        if f['timestamp']<=t: prev=f
        elif nxt is None: nxt=f
    if prev is None: return None
    pa=prev['participantFrames'][k]['position']
    if nxt is None: return (float(pa['x']),float(pa['y']))
    pb=nxt['participantFrames'][k]['position']
    w=(t-prev['timestamp'])/float(nxt['timestamp']-prev['timestamp'])
    return (pa['x']+w*(pb['x']-pa['x']), pa['y']+w*(pb['y']-pa['y']))
def interp_scalar(F,pid,t,field):
    k=str(pid);prev=None;nxt=None
    for f in F:
        if k not in f['participantFrames']: continue
        if f['timestamp']<=t: prev=f
        elif nxt is None: nxt=f
    if prev is None: return None
    a=prev['participantFrames'][k][field]
    if nxt is None: return float(a)
    b=nxt['participantFrames'][k][field]
    w=(t-prev['timestamp'])/float(nxt['timestamp']-prev['timestamp'])
    return a+w*(b-a)
def step_scalar(F,pid,t,field):
    k=str(pid);val=None
    for f in F:
        if k in f['participantFrames'] and f['timestamp']<=t: val=f['participantFrames'][k][field]
    return val
def all_events(tl):
    return [e for fr in tl['frames'] for e in fr['events']]
