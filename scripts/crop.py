"""Crop the top N rows off a PNG so a region can be inspected without a 4000px image."""
import struct, zlib, sys
src, dst, top, bottom = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
d = open(src, 'rb').read(); pos = 8; idat = b''
while pos < len(d):
    ln = struct.unpack('>I', d[pos:pos+4])[0]; typ = d[pos+4:pos+8]; data = d[pos+8:pos+8+ln]
    if typ == b'IHDR': w, h, bd, ct = struct.unpack('>IIBB', data[:10])
    if typ == b'IDAT': idat += data
    pos += 12 + ln
raw = zlib.decompress(idat); ch = {0:1,2:3,3:1,4:2,6:4}[ct]; stride = w*ch
prev = bytearray(stride); rows = []; p = 0
for y in range(h):
    f = raw[p]; p += 1; line = bytearray(raw[p:p+stride]); p += stride
    for i in range(stride):
        a = line[i-ch] if i >= ch else 0; b = prev[i]; c = prev[i-ch] if i >= ch else 0
        if f == 1: line[i] = (line[i]+a) & 255
        elif f == 2: line[i] = (line[i]+b) & 255
        elif f == 3: line[i] = (line[i]+(a+b)//2) & 255
        elif f == 4:
            pa, pb, pc = abs(b-c), abs(a-c), abs(a+b-2*c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = (line[i]+pr) & 255
    if top <= y < bottom: rows.append(bytes(line))
    prev = line
    if y >= bottom: break
H = len(rows); body = b''.join(b'\x00'+r for r in rows)
chunk = lambda t, dd: struct.pack('>I', len(dd)) + t + dd + struct.pack('>I', zlib.crc32(t+dd) & 0xffffffff)
open(dst, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, H, 8, ct, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(body)) + chunk(b'IEND', b''))
print('cropped', w, H)
