"""Start and remove an isolated PostgreSQL cluster from explicitly supplied binaries."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pg-bin', required=True, type=Path)
    parser.add_argument('--node', default='node', help='Node.js 24 executable')
    args = parser.parse_args()
    binaries = args.pg_bin.resolve()
    with tempfile.TemporaryDirectory(prefix='catalog-integration-') as directory:
        folder = Path(directory)
        password = secrets.token_hex(32)
        password_file = folder / 'password'
        password_file.write_text(password)
        password_file.chmod(0o600)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        data = folder / 'data'
        subprocess.run([str(binaries / 'initdb'), '-D', str(data), '--username=catalog_test_root',
                        '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile=' + str(password_file),
                        '--encoding=UTF8', '--locale=C'], capture_output=True, check=True)
        config = folder / 'test.json'
        config.write_text(json.dumps(dict(host='127.0.0.1', port=port, user='catalog_test_root',
                                         password=password, database='postgres', ssl=False)))
        config.chmod(0o600)
        options = f'-h 127.0.0.1 -p {port} -k {folder} -c max_connections=40 -c shared_buffers=32MB -c log_statement=none -c log_min_error_statement=panic'
        started = False
        try:
            subprocess.run([str(binaries / 'pg_ctl'), '-D', str(data), '-l', str(folder / 'server.log'),
                            '-o', options, '-w', 'start'], capture_output=True, check=True)
            started = True
            env = dict(os.environ, CATALOG_TEST_CONFIG=str(config))
            result = subprocess.run([args.node, '--test', str(ROOT / 'tests/integration.cjs')], env=env)
            return result.returncode
        finally:
            if started:
                subprocess.run([str(binaries / 'pg_ctl'), '-D', str(data), '-m', 'immediate', '-w', 'stop'], capture_output=True, check=True)


if __name__ == '__main__':
    raise SystemExit(main())
