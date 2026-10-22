import sys, os, numpy as np
from PIL import Image
D = os.environ.get('QA_SHOTS', 'qa/shots/') + 'mcp-Claude_Browser-blob-'  # 截圖所在的資料夾（當初比對用的是預覽工具存下的截圖）
OUT = r'D:/sanguo-life/qa/diff'
pairs = {'bottom': ('1792602775974-6h9ho2', '1792602805792-hn0jrq'),
         'rec100': ('1792602853856-bkfb9o', '1792602844375-ow1npl'),
         'rec270': ('1792602782294-1yevtd', '1792602815178-csxnqv'),
         'rec450': ('1792602785636-o4j97p', '1792602818155-x51gjf')}
def load(k):
    im = Image.open(D + k + '.jpg').convert('L')
    return im.resize((375, 812), Image.LANCZOS) if im.size != (375, 812) else im
for name, (a, b) in pairs.items():
    A, B = load(a), load(b)
    A.save(f'{OUT}/{name}_before.png'); B.save(f'{OUT}/{name}_after.png')
    x, y = np.asarray(A, dtype=int), np.asarray(B, dtype=int)
    d = np.abs(x - y); d[:, -10:] = 0   # 右緣捲軸（只在捲動後短暫出現）不算
    bad = d > 48                           # JPEG 壓縮雜訊以上才算不同
    Image.fromarray(np.where(bad, 255, (x * 0.3).astype(np.uint8)).astype(np.uint8)).save(f'{OUT}/{name}_diff.png')
    ys = np.where(bad.any(axis=1))[0]
    print(f'{name}: 平均差 {d.mean():.2f}，明顯不同像素 {bad.sum()} / {bad.size}（{bad.mean()*100:.3f}%）' + (f'，集中在 y={ys.min()}–{ys.max()}' if len(ys) else ''))

print('--- 逐條對齊（每 16px 一條，允許上下各 3px）')
for name, (a, b) in pairs.items():
    x = np.asarray(load(a), dtype=int); y = np.asarray(load(b), dtype=int)
    x = x[:, :-10]; y = y[:, :-10]
    shifts = {}; worst = 0; badpx = 0
    for top in range(3, 812 - 19, 16):
        ref = x[top:top+16]
        best = min(((np.abs(ref - y[top+dy:top+dy+16]).mean(), dy) for dy in range(-3, 4)), key=lambda t: t[0])
        shifts[best[1]] = shifts.get(best[1], 0) + 1
        worst = max(worst, best[0])
        badpx += int((np.abs(ref - y[top+best[1]:top+best[1]+16]) > 48).sum())
    print(f'{name}: 位移分布 {dict(sorted(shifts.items()))}，對齊後最差條平均差 {worst:.2f}，剩下明顯不同像素 {badpx}')
