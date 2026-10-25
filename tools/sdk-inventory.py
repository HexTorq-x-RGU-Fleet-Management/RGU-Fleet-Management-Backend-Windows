"""Read installed PE export names without loading or executing the DLL."""
import hashlib
import json
import os
from pathlib import Path
import struct


def exported_names(data):
    def u16(offset):
        return struct.unpack_from('<H', data, offset)[0]

    def u32(offset):
        return struct.unpack_from('<I', data, offset)[0]

    if data[:2] != b'MZ':
        raise ValueError('Not a PE file')
    pe = u32(0x3c)
    if data[pe:pe + 4] != b'PE\0\0':
        raise ValueError('Invalid PE header')
    count, optional_size = u16(pe + 6), u16(pe + 20)
    optional = pe + 24
    magic = u16(optional)
    if magic not in (0x10b, 0x20b):
        raise ValueError('Unsupported PE format')
    directory = optional + (96 if magic == 0x10b else 112)
    sections = optional + optional_size

    def offset(rva):
        for index in range(count):
            section = sections + index * 40
            virtual_size, address, raw_size, raw_start = struct.unpack_from('<IIII', data, section + 8)
            if address <= rva < address + max(virtual_size, raw_size):
                delta = rva - address
                if delta >= raw_size:
                    raise ValueError('RVA has no file data')
                return raw_start + delta
        raise ValueError('RVA is outside sections')

    export = offset(u32(directory))
    names_count, names_rva = u32(export + 24), u32(export + 32)
    if names_count > 100000:
        raise ValueError('Invalid export count')
    table = offset(names_rva)
    names = []
    for index in range(names_count):
        start = offset(u32(table + index * 4))
        end = data.find(b'\0', start, start + 512)
        if end < 0:
            raise ValueError('Unterminated export name')
        names.append(data[start:end].decode('ascii'))
    return magic, sorted(names)


if __name__ == '__main__':
    directory = Path(os.environ.get('HIK_SDK_DIRECTORY', r'C:\Program Files (x86)\iVMS-4200 Site\iVMS-4200 Client\Client'))
    try:
        data = (directory / 'OpenNetStream.dll').read_bytes()
        magic, names = exported_names(data)
        relevant = [name for name in names if name.startswith('OpenSDK_') and any(word in name.lower() for word in ('token', 'login', 'auth', 'play', 'session', 'callback'))]
        print(json.dumps({'architecture': 'x64' if magic == 0x20b else 'x86', 'sha256': hashlib.sha256(data).hexdigest(), 'exportCount': len(names), 'relevantExports': relevant}))
    except (OSError, ValueError, struct.error):
        print(json.dumps({'state': 'unavailable', 'message': 'Could not inspect the installed SDK exports.'}))
        raise SystemExit(1)
