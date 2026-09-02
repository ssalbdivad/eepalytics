import sys,math,statistics,collections,json;sys.path.insert(0,'lib');import sr
BRW=[0,10,10,12,12,14,16,20,21,22,24,25,28,32.5,35,37.5,40,42.5,45]  # UNVERIFIED index=level
def tif(t):
    m=t/60.0
    if m<15: return 0.0
    if m<30: return 0.00425*((m-15)*2)      # UNVERIFIED
    if m<45: return 0.1275+0.003*((m-30)*2) # UNVERIFIED
    return 0.1725+0.01450*((m-45)*2)        # UNVERIFIED
def death_timer(level,t): return BRW[max(1,min(18,int(level or 1)))]*(1+tif(t))

def game_moments(gid):
    g,tl=sr.load(gid);F=tl['frames'];mypid=sr.me(g);myteam=sr.team_of(mypid)
    oteam=200 if myteam==100 else 100
    roles,_,_=sr.infer_roles(g,tl)
    E=sr.all_events(tl); end=F[-1]['timestamp']
    gpm=[p for p in g['participants'] if p['participantId']==mypid][0]['stats']['goldEarned']/(g['gameDuration']/60.0)
    out=[]
    for e in E:
        if e['type']!='CHAMPION_KILL' or e['victimId']!=mypid: continue
        t=e['timestamp'];x,y=e['position']['x'],e['position']['y']
        lvl=sr.step_scalar(F,mypid,t,'level') or 1
        z=sr.zone(x,y,myteam);half=sr.side_half(x,y,myteam)
        # isolation
        proven=set()
        for o in E:
            if o['type']!='CHAMPION_KILL' or abs(o['timestamp']-t)>10000: continue
            if math.hypot(o['position']['x']-x,o['position']['y']-y)>2500: continue
            for c in [o['killerId']]+list(o['assistingParticipantIds'])+[o['victimId']]:
                if c and c!=mypid and sr.team_of(c)==myteam: proven.add(c)
        p=sr.interp_pos(F,mypid,t)
        allyd=sorted(math.hypot(sr.interp_pos(F,a,t)[0]-x,sr.interp_pos(F,a,t)[1]-y)
                     for a in range(1,11) if a!=mypid and sr.team_of(a)==myteam)
        solo = (len(proven)==0 and allyd[0]>2500)
        nk=1+len(e['assistingParticipantIds'])
        # objective lost within 45s
        objlost=[o for o in E if o['type']=='ELITE_MONSTER_KILL' and 0<=o['timestamp']-t<=45000 and sr.team_of(o['killerId'])==oteam]
        # gold state
        egold=None
        ej=[q for q in range(1,11) if sr.team_of(q)!=myteam and roles[q]=='JGL'][0]
        gd=(sr.interp_scalar(F,mypid,t,'totalGold') or 0)-(sr.interp_scalar(F,ej,t,'totalGold') or 0)
        dt=death_timer(lvl,t/1000.0)
        cost = 300 + 150*(nk-1) + gpm*dt/60.0 + 500*len(objlost)
        fix  = (1.6 if solo else 1.0) * (1.4 if nk<=2 else 0.8) * (1.3 if half=='ENEMY' and gd<0 else 1.0) * (0.6 if t<90000 else 1.0)
        out.append(dict(kind='DEATH',gameId=gid,t=t/1000.0,x=x,y=y,zone=z,half=half,level=lvl,
            gdiff_vs_jgl=round(gd),killers=nk,solo=solo,nearest_ally=round(allyd[0]),
            obj_lost_45s=[o['monsterType'] for o in objlost],est_downtime_s=round(dt,1),
            cost_gold=round(cost),fixability=round(fix,2),
            sig=(z,'EARLY' if t<600000 else 'MID' if t<1500000 else 'LATE','SOLO' if solo else 'GROUP')))
    # objectives conceded while user was far away
    for e in E:
        if e['type']!='ELITE_MONSTER_KILL' or sr.team_of(e['killerId'])!=oteam: continue
        t=e['timestamp'];x,y=e['position']['x'],e['position']['y']
        p=sr.interp_pos(F,mypid,t); d=math.hypot(p[0]-x,p[1]-y)
        if d<3000: continue
        val={'BARON_NASHOR':1500,'DRAGON':800,'RIFTHERALD':500,'HORDE':200}.get(e['monsterType'],300)
        out.append(dict(kind='OBJECTIVE_CONCEDED',gameId=gid,t=t/1000.0,x=x,y=y,zone=sr.zone(x,y,myteam),
            half=sr.side_half(x,y,myteam),monster=e['monsterType'],sub=e['monsterSubType'],
            my_dist=round(d),cost_gold=val,fixability=1.0,
            sig=(e['monsterType'],'EARLY' if t<600000 else 'MID' if t<1500000 else 'LATE','ABSENT')))
    return out

def rank(all_moments,gid,topn=8):
    sigcount=collections.Counter()
    for m in all_moments: sigcount[m['sig']]+=1
    ngames=len({m['gameId'] for m in all_moments})
    res=[]
    for m in all_moments:
        if m['gameId']!=gid: continue
        rep=sigcount[m['sig']]
        recur=1.0+0.35*math.log(max(rep,1))
        m=dict(m); m['recurrence_n']=rep
        m['score']=round(m['cost_gold']*m['fixability']*recur)
        res.append(m)
    res.sort(key=lambda r:-r['score'])
    # temporal de-dup: no two moments within 25s
    keep=[]
    for r in res:
        if all(abs(r['t']-k['t'])>25 for k in keep): keep.append(r)
        if len(keep)>=topn: break
    return keep
if __name__=='__main__':
    allm=[]
    for gid in sr.ids(): allm+=game_moments(gid)
    print('total moments mined across %d games: %d'%(len(sr.ids()),len(allm)))
    gid=sys.argv[1] if len(sys.argv)>1 else '5633857616'
    for i,m in enumerate(rank(allm,gid),1):
        if m['kind']=='DEATH':
            print('%d. [%5.1fs=%02d:%02d] score=%5d DEATH  %-16s %-8s lvl%-2s gd%+5d killers=%d solo=%-5s nearestAlly=%5d objLost=%s downtime~%ss recur=%d'%(
              i,m['t'],int(m['t'])//60,int(m['t'])%60,m['score'],m['zone'],m['half'],m['level'],m['gdiff_vs_jgl'],m['killers'],m['solo'],m['nearest_ally'],m['obj_lost_45s'],m['est_downtime_s'],m['recurrence_n']))
        else:
            print('%d. [%5.1fs=%02d:%02d] score=%5d OBJ    %-16s conceded %s/%s  myDist=%d recur=%d'%(
              i,m['t'],int(m['t'])//60,int(m['t'])%60,m['score'],m['zone'],m['monster'],m['sub'],m['my_dist'],m['recurrence_n']))
