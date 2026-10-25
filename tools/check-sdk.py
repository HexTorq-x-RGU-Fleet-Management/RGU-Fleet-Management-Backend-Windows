"""Inspect/load installed DLLs without SDK initialization, login or cloud calls."""
import ctypes as C
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile


def main():
    if sys.platform != 'win32':
        raise RuntimeError('Installed SDK loading requires Windows')
    root = Path(os.environ.get('HIK_SDK_DIRECTORY', r'C:\Program Files (x86)\iVMS-4200 Site\iVMS-4200 Client\Client')).resolve()
    spec = importlib.util.spec_from_file_location('inventory', Path(__file__).with_name('sdk-inventory.py'))
    inventory = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inventory)
    data = (root / 'OpenNetStream.dll').read_bytes()
    magic, exports = inventory.exported_names(data)
    if magic != 0x20b:
        raise RuntimeError('This backend expects an x64 SDK')
    required = ['OpenSDK_InitLib', 'OpenSDK_SetAccessToken', 'OpenSDK_AllocSessionEx']
    if any(name not in exports for name in required):
        raise RuntimeError('Expected SDK entry points are missing')
    handles = [os.add_dll_directory(str(directory)) for directory in
               [root, root / 'HCNetSDKCom', root / 'PlayCtrl', root / 'Microsoft.VC90.MFC'] if directory.is_dir()]
    previous = os.getcwd()
    loaded = []
    with tempfile.TemporaryDirectory(prefix='rgu-sdk-check-') as temporary:
        os.chdir(temporary)
        try:
            for name in ['OpenNetStream.dll', 'HCNetSDK.dll', 'PlayCtrl.dll']:
                dll = C.WinDLL(str(root / name))
                if name == 'OpenNetStream.dll':
                    for entry in required:
                        getattr(dll, entry)
                loaded.append(name)
        finally:
            os.chdir(previous)
    for handle in handles:
        handle.close()
    print(json.dumps({'architecture': 'x64', 'sha256': hashlib.sha256(data).hexdigest(),
                      'loadChecked': loaded, 'entryPoints': required, 'cloudApiCalled': False}))


if __name__ == '__main__':
    main()
