import sys,json,math;sys.path.insert(0,'lib');import sr
import numpy as np
from PIL import Image,ImageDraw
MINX,MINY,MAXX,MAXY=-120.0,-120.0,14870.0,14980.0
S=512
def to_px(x,y): return ((x-MINX)/(MAXX-MINX)*S, S-(y-MINY)/(MAXY-MINY)*S)
def gauss_blur(a,sigma):
    r=int(3*sigma); k=np.exp(-0.5*((np.arange(-r,r+1)/sigma)**2)); k/=k.sum()
    out=np.apply_along_axis(lambda m: np.convolve(m,k,mode='same'),0,a)
    return np.apply_along_axis(lambda m: np.convolve(m,k,mode='same'),1,out)
def render(points,out,title,sigma=13.0):
    acc=np.zeros((S,S),dtype=float)
    for x,y in points:
        px,py=to_px(x,y); ix,iy=int(px),int(py)
        if 0<=ix<S and 0<=iy<S: acc[iy,ix]+=1.0
    acc=gauss_blur(acc,sigma); mx=acc.max() or 1.0
    t=np.clip(acc/mx,0,1)
    base=np.asarray(Image.open('map11.png').convert('RGB').resize((S,S)),dtype=float)*0.55
    r=np.where(t<0.5,0,510*(t-0.5)); g=np.where(t<0.5,120+270*t,255-240*(t-0.5)); b=np.where(t<0.5,255-200*t,np.maximum(0,55-110*(t-0.5)))
    al=(np.clip(t*1.3,0,1)**0.75)[...,None]
    img=np.clip(base*(1-al)+np.stack([r,g,b],-1)*al,0,255).astype('uint8')
    im=Image.fromarray(img); ImageDraw.Draw(im).text((6,6),title,fill=(255,255,255))
    im.save(out); return float(mx)
if __name__=='__main__':
    D=json.load(open('deaths.json'))
    print('deaths peak %.3f'%render([(d['x'],d['y']) for d in D],'heat_deaths.png','DEATHS n=%d / 22 games'%len(D)))
    pts=[]
    for gid in sr.ids():
        g,tl=sr.load(gid);mypid=sr.me(g)
        for f in tl['frames'][1:]:
            p=f['participantFrames'].get(str(mypid))
            if p: pts.append((p['position']['x'],p['position']['y']))
    print('presence peak %.3f'%render(pts,'heat_presence.png','PRESENCE n=%d frames / 22 games'%len(pts)))
