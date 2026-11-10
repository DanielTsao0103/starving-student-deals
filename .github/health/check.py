"""Read-only check of the live site and its catalog.

Runs from this public repository because Actions minutes are free here. It loads the
site, reads version.txt, and asks the database for the catalog (which also keeps the
free database from pausing for inactivity). It never signs in and never writes.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request

SITE_URL = 'https://danieltsao0103.github.io/starving-student-deals/'
SUPABASE_URL = 'https://gloiirtultxnjgwlphld.supabase.co'
ATTEMPTS = 3          # A single slow response should not send a failure email.
WAIT_SECONDS = 20


def fetch(url: str, *, key: str = '', post: bool = False) -> bytes:
    """One request with a timeout; any status other than 200 raises."""
    headers = {'User-Agent': 'deals-health/1.0'}
    if key:
        headers['apikey'] = key
    if post:
        headers['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=b'{}' if post else None, headers=headers,
                                     method='POST' if post else 'GET')
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError(f'Unexpected HTTP status {response.status}')
        return response.read()


def check(key: str) -> dict:
    """Fail on missing configuration, a broken release, or an empty catalog."""
    if not key.strip():
        raise ValueError('SUPABASE_PUBLISHABLE_KEY is missing')
    if b'<html' not in fetch(SITE_URL).lower():
        raise ValueError('Site did not return HTML')
    version = fetch(SITE_URL + 'version.txt').decode().strip()
    if not re.fullmatch(r'[0-9a-f]{7,40}', version):
        raise ValueError('version.txt must contain a Git commit hash')
    catalog = json.loads(fetch(SUPABASE_URL + '/rest/v1/rpc/catalog', key=key, post=True))
    offers = catalog['offers']
    # No exact count here: the catalog grows and shrinks, and this copy should not need
    # editing each time. An empty list or repeated ids means the catalog is broken.
    if not offers or len({offer['id'] for offer in offers}) != len(offers):
        raise ValueError('Catalog is empty or has repeated offer ids')
    if not catalog.get('version'):
        raise ValueError('Catalog version is missing')
    return {'site_commit': version, 'offers': len(offers), 'catalog_version': catalog['version']}


def check_with_retries(key: str, sleep=time.sleep) -> dict:
    """Retry network trouble; a wrong answer (ValueError) fails at once."""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return check(key)
        except ValueError:
            raise
        except Exception as error:  # Timeouts, DNS, 5xx.
            if attempt == ATTEMPTS:
                raise
            print(f'Attempt {attempt} failed ({type(error).__name__}); retrying in {WAIT_SECONDS}s')
            sleep(WAIT_SECONDS)
    raise AssertionError('unreachable')


if __name__ == '__main__':
    print(check_with_retries(os.environ.get('SUPABASE_PUBLISHABLE_KEY', '')))
