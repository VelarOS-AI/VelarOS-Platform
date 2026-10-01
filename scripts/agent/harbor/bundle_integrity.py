"""Verify a prepared candidate before copying or reusing a portable archive."""

import hashlib
import json
from pathlib import Path


def verify_bundle(bundle):
    bundle = Path(bundle)
    identity = json.loads((bundle / 'identity.json').read_text())
    seal = identity.get('bundleSeal')
    if not isinstance(seal, dict) or seal.get('schemaVersion') != 1 or not isinstance(seal.get('filesSha256'), dict):
        raise ValueError('Bundle has no supported content seal; prepare a new versioned candidate')
    actual = {}

    def visit(directory, prefix=''):
        for path in directory.iterdir():
            name = f'{prefix}/{path.name}' if prefix else path.name
            if name == 'identity.json':
                continue
            if path.is_symlink():
                raise ValueError(f'Bundle contains symlink: {name}')
            if path.name == 'node_modules' and path.is_dir():
                continue
            if path.is_dir():
                visit(path, name)
            elif path.is_file():
                with path.open('rb') as source:
                    actual[name] = hashlib.file_digest(source, 'sha256').hexdigest()
            else:
                raise ValueError(f'Bundle contains unsupported entry: {name}')

    visit(bundle)
    if actual != seal['filesSha256']:
        raise ValueError('Bundle files differ from the prepared content seal; prepare a new versioned candidate')
    digest = hashlib.sha256()
    for name in sorted(actual, key=lambda value: value.encode('utf-8')):
        digest.update(name.encode('utf-8') + b'\0' + actual[name].encode('ascii') + b'\n')
    if digest.hexdigest() != seal.get('sha256'):
        raise ValueError('Bundle seal digest differs')
    return identity
