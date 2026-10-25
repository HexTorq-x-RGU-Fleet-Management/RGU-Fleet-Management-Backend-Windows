"""Prepare a pinned, private PostgreSQL 17.11 runtime without installing a service."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent / '.local'
URL = 'https://get.enterprisedb.com/postgresql/postgresql-17.11-1-windows-x64-binaries.zip'


def main():
    if sys.platform != 'win32':
        raise RuntimeError('This helper prepares the Windows runtime only')
    ROOT.mkdir(exist_ok=True)
    archive = ROOT / 'postgresql-17.11.zip'
    for attempt in range(5):
        if archive.exists() and zipfile.is_zipfile(archive):
            break
        offset = archive.stat().st_size if archive.exists() else 0
        request = urllib.request.Request(URL, headers={'Range': f'bytes={offset}-'})
        print(f'Preparing PostgreSQL 17.11: resume at {offset} bytes', flush=True)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                partial = response.status == 206
                if partial and not response.headers.get('Content-Range', '').startswith(f'bytes {offset}-'):
                    raise RuntimeError('Unexpected archive range response')
                with archive.open('ab' if partial else 'wb') as output:
                    while block := response.read(1024 * 1024):
                        output.write(block)
        except (OSError, TimeoutError) as error:
            if attempt == 4:
                raise RuntimeError('Could not download PostgreSQL. Retry prepare:db to resume.') from error
            print('Download interrupted; retrying the remaining range.', flush=True)
    if not zipfile.is_zipfile(archive):
        raise RuntimeError('The PostgreSQL archive is incomplete')
    destination = (ROOT / 'postgresql').resolve()
    destination.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as package:
        selected = [entry for entry in package.infolist() if not entry.is_dir() and
                    entry.filename.startswith(('pgsql/bin/', 'pgsql/lib/', 'pgsql/share/'))]
        for entry in selected:
            target = (destination / entry.filename).resolve()
            if not target.is_relative_to(destination):
                raise RuntimeError('Archive path escaped the private runtime directory')
            target.parent.mkdir(parents=True, exist_ok=True)
            with package.open(entry) as source, target.open('wb') as output:
                shutil.copyfileobj(source, output)
    digest = hashlib.sha256()
    with archive.open('rb') as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    (ROOT / 'postgresql-download.json').write_text(json.dumps({
        'version': '17.11', 'url': URL, 'bytes': archive.stat().st_size,
        'sha256': digest.hexdigest(), 'filesExtracted': len(selected),
    }, indent=2), encoding='utf-8')
    print(f'Private PostgreSQL binaries prepared ({len(selected)} files). No database was started.', flush=True)


if __name__ == '__main__':
    main()
