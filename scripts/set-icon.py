# -*- coding: utf-8 -*-
"""直接调 Win32 UpdateResource 给 exe 换图标（rcedit 在这台机器上跑不动）。"""
import ctypes
import os
import struct
import sys
from ctypes import wintypes

k32 = ctypes.WinDLL('kernel32', use_last_error=True)

k32.BeginUpdateResourceW.argtypes = [wintypes.LPCWSTR, wintypes.BOOL]
k32.BeginUpdateResourceW.restype = wintypes.HANDLE

k32.UpdateResourceW.argtypes = [
    wintypes.HANDLE, wintypes.LPVOID, wintypes.LPVOID,
    wintypes.WORD, wintypes.LPVOID, wintypes.DWORD,
]
k32.UpdateResourceW.restype = wintypes.BOOL

k32.EndUpdateResourceW.argtypes = [wintypes.HANDLE, wintypes.BOOL]
k32.EndUpdateResourceW.restype = wintypes.BOOL

RT_ICON = 3
RT_GROUP_ICON = 14


def err():
    e = ctypes.get_last_error()
    return f'{e}: {ctypes.FormatError(e)}'


def parse_ico(path):
    data = open(path, 'rb').read()
    reserved, typ, count = struct.unpack_from('<HHH', data, 0)
    assert typ == 1, '不是 ico 文件'
    out = []
    for i in range(count):
        w, h, cc, r, planes, bpp, size, offset = struct.unpack_from('<BBBBHHII', data, 6 + 16 * i)
        w = 256 if w == 0 else w
        h = 256 if h == 0 else h
        out.append({'w': w, 'h': h, 'data': data[offset:offset + size]})
    return out


def build_group(images):
    """构造 GRPICONDIR"""
    b = struct.pack('<HHH', 0, 1, len(images))
    for i, im in enumerate(images):
        b += struct.pack(
            '<BBBBHHIH',
            0 if im['w'] >= 256 else im['w'],
            0 if im['h'] >= 256 else im['h'],
            0, 0, 1, 32, len(im['data']), i + 1,
        )
    return b


def set_icon(exe, ico):
    images = parse_ico(ico)
    print(f'  ico 里有 {len(images)} 个尺寸：{[i["w"] for i in images]}')

    h = k32.BeginUpdateResourceW(exe, False)
    if not h:
        print('  失败：BeginUpdateResource 打不开文件 —', err())
        return False
    print('  BeginUpdateResource 成功')

    # 不删除旧资源。
    # 踩过的坑（2026-09-14）：在这里调 UpdateResource(h,type,name,lang,NULL,0) 声称删除，
    # 在这台机器上每次都返回错误 1359，而且会把 hUpdate 弄成错误状态，
    # 导致后续的写入和收尾全部失败。直接覆盖就行 ——
    # Windows 靠 GROUP_ICON（ID=1）决定用哪套图标，多出来的旧 ICON 只是占点空间。

    ok_count = 0
    for i, im in enumerate(images):
        buf = ctypes.create_string_buffer(im['data'], len(im['data']))
        ok = k32.UpdateResourceW(
            h, ctypes.c_void_p(RT_ICON), ctypes.c_void_p(i + 1), 0, buf, len(im['data'])
        )
        if ok:
            ok_count += 1
        else:
            print(f'  写 RT_ICON #{i + 1} 失败 —', err())
    print(f'  写入 {ok_count}/{len(images)} 个尺寸图')

    grp = build_group(images)
    gbuf = ctypes.create_string_buffer(grp, len(grp))
    ok = k32.UpdateResourceW(h, ctypes.c_void_p(RT_GROUP_ICON), ctypes.c_void_p(1), 0, gbuf, len(grp))
    print('  写 GROUP_ICON', '成功' if ok else '失败 — ' + err())

    ok = k32.EndUpdateResourceW(h, False)
    print('  EndUpdateResource（写盘）', '成功' if ok else '失败 — ' + err())
    return bool(ok)


if __name__ == '__main__':
    # Win32 API 不认相对路径（工作目录跟 shell 不一样），一律转成绝对路径
    exe = os.path.abspath(sys.argv[1])
    ico = os.path.abspath(sys.argv[2])
    print(f'目标：{exe}')
    sys.exit(0 if set_icon(exe, ico) else 1)
