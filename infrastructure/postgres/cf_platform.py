"""CF transport and disposable task orchestration; never retrieve binding details."""
import contextlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from validate_catalog import read_json

ROOT = Path(__file__).resolve().parent
MANAGED_BY = 'cap-postgres-catalog-v1'


class PlatformError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def load_target(path):
    target = read_json(path)
    if set(target) != {'api', 'org', 'space', 'services'}:
        raise PlatformError('Invalid target fields')
    api = urllib.parse.urlsplit(target['api'])
    if api.scheme != 'https' or not api.hostname or api.username or api.password or api.query or api.fragment or api.path not in ('', '/') or 'YOUR_' in target['api']:
        raise PlatformError('Configure an HTTPS CF API endpoint without credentials')
    if not all(isinstance(target[k], str) and target[k] and 'YOUR_' not in target[k] for k in ['org', 'space']) or target['space'] != 'dev':
        raise PlatformError('Configure the organization and the dev space')
    services = target['services']
    if set(services) != {'postgres', 'credentials'}:
        raise PlatformError('Expected PostgreSQL and Credential Store services')
    expected = {
        'postgres': ('cap-lab-dev-postgres', 'postgresql-db', {'engine_version': '16'}),
        'credentials': ('cap-lab-dev-credentials', 'credstore', {'authentication': {'type': 'mtls'}}),
    }
    for key, (name, offering, parameters) in expected.items():
        service = services[key]
        if set(service) != {'name', 'offering', 'plan', 'parameters'} or (service['name'], service['offering'], service['plan'], service['parameters']) != (name, offering, 'trial', parameters):
            raise PlatformError('MVP accepts only the declared trial service profiles; no paid fallback')
    return target


@contextlib.contextmanager
def session(target):
    source = Path(os.environ.get('CF_HOME', str(Path.home()))) / '.cf/config.json'
    config = read_json(source)
    if (config.get('Target', '').rstrip('/'), config.get('OrganizationFields', {}).get('Name'), config.get('SpaceFields', {}).get('Name')) != (target['api'].rstrip('/'), target['org'], target['space']):
        raise PlatformError('CF target differs from the declared target; use cf login/target first')
    if not config.get('AccessToken'):
        raise PlatformError('CF login is required')
    with tempfile.TemporaryDirectory(prefix='catalog-cf-') as folder:
        cf = Path(folder) / '.cf'
        cf.mkdir(mode=0o700)
        shutil.copyfile(source, cf / 'config.json')
        (cf / 'config.json').chmod(0o600)
        yield CloudFoundry(target, config, Path(folder))


class CloudFoundry:
    def __init__(self, target, config, home):
        self.target, self.config, self.home = target, config, home
        self.space = config['SpaceFields']['GUID']
        self.refreshed = False

    def request(self, path, method='GET', body=None, missing_ok=False):
        endpoint = self.target['api'].rstrip('/')
        url = path if path.startswith('https://') else endpoint + path
        if not url.startswith(endpoint + '/'):
            raise PlatformError('Unexpected CF API origin')
        # CLI operations may refresh only the temporary profile.
        self.config = read_json(self.home / '.cf/config.json')
        req = urllib.request.Request(url, method=method,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': self.config['AccessToken'], 'Accept': 'application/json', 'Content-Type': 'application/json'})
        try:
            with urllib.request.build_opener(NoRedirect()).open(req, timeout=45) as response:
                raw = response.read()
                return response.status, response.headers, json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            if error.code == 401 and not self.refreshed:
                self.refreshed = True
                token = self.cli('oauth-token', timeout=45).strip()
                if not token.lower().startswith('bearer ') or '\n' in token:
                    raise PlatformError('CF authentication expired; run cf login --sso') from None
                config_file = self.home / '.cf/config.json'
                refreshed = read_json(config_file)
                refreshed['AccessToken'] = token
                config_file.write_text(json.dumps(refreshed))
                config_file.chmod(0o600)
                return self.request(path, method, body, missing_ok)
            if error.code == 404 and missing_ok:
                return 404, {}, None
            raise PlatformError(f'CF API HTTP {error.code} ({method}); response body omitted') from None

    def resources(self, path):
        result = []
        while path:
            _, _, page = self.request(path)
            result.extend(page['resources'])
            following = page.get('pagination', {}).get('next')
            path = following['href'] if following else None
        return result

    def verify_target(self):
        _, _, space = self.request('/v3/spaces/' + self.space)
        _, _, org = self.request('/v3/organizations/' + space['relationships']['organization']['data']['guid'])
        if (space['name'], org['name']) != (self.target['space'], self.target['org']):
            raise PlatformError('Remote CF target mismatch')

    def wait_job(self, location):
        deadline, next_update = time.monotonic() + 1800, 0
        while time.monotonic() < deadline:
            _, _, job = self.request(location)
            if job['state'] == 'COMPLETE':
                return
            if job['state'] == 'FAILED':
                raise PlatformError('CF asynchronous operation failed; error details omitted')
            if time.monotonic() >= next_update:
                print('CF operation pending: ' + job['state'], flush=True)
                next_update = time.monotonic() + 30
            time.sleep(3)
        raise PlatformError('CF operation still pending; inspect its state before retrying')

    def service(self, spec, create=False):
        query = urllib.parse.urlencode({'space_guids': self.space, 'names': spec['name']})
        matches = self.resources('/v3/service_instances?' + query)
        if not matches:
            if not create:
                raise PlatformError('Service missing: ' + spec['name'] + '; run bootstrap first')
            offers = self.resources('/v3/service_offerings?' + urllib.parse.urlencode({'names': spec['offering']}))
            plans = []
            for offer in offers:
                plans.extend(self.resources('/v3/service_plans?' + urllib.parse.urlencode({'service_offering_guids': offer['guid'], 'names': spec['plan']})))
            if len(plans) != 1:
                raise PlatformError('Expected exactly one available requested service plan')
            _, headers, _ = self.request('/v3/service_instances', 'POST', {
                'type': 'managed', 'name': spec['name'], 'parameters': spec['parameters'],
                'metadata': {'labels': {'managed_by': MANAGED_BY, 'profile': 'shared-dev'}},
                'relationships': {'space': {'data': {'guid': self.space}}, 'service_plan': {'data': {'guid': plans[0]['guid']}}},
            })
            if headers.get('Location'):
                self.wait_job(headers['Location'])
            # Managed creation may return 202 with only a job Location and no body.
            matches = self.resources('/v3/service_instances?' + query)
        if len(matches) != 1:
            raise PlatformError('Service name is ambiguous')
        guid = matches[0]['guid']
        deadline, next_update = time.monotonic() + 1800, 0
        while time.monotonic() < deadline:
            _, _, service = self.request('/v3/service_instances/' + guid)
            labels = service.get('metadata', {}).get('labels', {})
            if labels.get('managed_by') != MANAGED_BY or labels.get('profile') != 'shared-dev' or service['relationships']['space']['data']['guid'] != self.space:
                raise PlatformError('Refusing to adopt a service outside this provisioner')
            _, _, plan = self.request('/v3/service_plans/' + service['relationships']['service_plan']['data']['guid'])
            _, _, offering = self.request('/v3/service_offerings/' + plan['relationships']['service_offering']['data']['guid'])
            if (offering['name'], plan['name']) != (spec['offering'], spec['plan']):
                raise PlatformError('Existing service uses another offering or plan')
            operation = service.get('last_operation', {})
            if operation.get('state') == 'succeeded':
                return service
            if operation.get('state') == 'failed' or operation.get('type') == 'delete':
                raise PlatformError('Service operation failed or deletion is in progress')
            if time.monotonic() >= next_update:
                print('Service pending: ' + spec['name'], flush=True)
                next_update = time.monotonic() + 30
            time.sleep(5)
        raise PlatformError('Service still provisioning; retry after it becomes ready')

    def cli(self, *args, timeout=600):
        env = dict(os.environ, CF_HOME=str(self.home), CF_COLOR='false')
        env.pop('CF_TRACE', None)
        result = subprocess.run(['cf', *args], env=env, capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise PlatformError('CF CLI failed: ' + args[0] + '; output omitted')
        return result.stdout

    @staticmethod
    def markers(logs):
        result = []
        allowed = {'ok','mode','app_id','environment','phase','credentialsInStore','crudVerified','runtimeDdlDenied','applications','crossDatabaseDenied','otherSecretsDenied','errorCode','httpStatus'}
        for line in logs.splitlines():
            if 'CATALOG_RESULT ' not in line:
                continue
            try:
                marker = json.loads(line.split('CATALOG_RESULT ', 1)[1])
                if isinstance(marker, dict) and set(marker) <= allowed:
                    result.append(marker)
            except (ValueError, TypeError):
                pass
        return result

    def task(self, plan, mode, app_id=None):
        task_name = 'cap-catalog-' + mode + '-' + uuid.uuid4().hex[:10]
        specs = self.target['services']
        namespaces = {}
        if mode == 'apply':
            for app in plan['applications']:
                for ns in app['credential_namespaces'].values():
                    namespaces[ns] = ['read', 'create', 'update']
        else:
            selected = next(a for a in plan['applications'] if a['app_id'] == app_id)
            namespaces = {selected['credential_namespaces']['runtime']: ['read']}
        bindings = [{'name': specs['credentials']['name'], 'parameters': {'authorization': {'default_permissions': [], 'namespace_permissions': namespaces}}}]
        if mode == 'apply':
            bindings.insert(0, {'name': specs['postgres']['name']})
        _, _, app = self.request('/v3/apps', 'POST', {
            'name': task_name, 'relationships': {'space': {'data': {'guid': self.space}}},
            'metadata': {'labels': {'managed_by': MANAGED_BY}},
            'lifecycle': {'type': 'buildpack', 'data': {'buildpacks': ['nodejs_buildpack']}},
        })
        try:
            with tempfile.TemporaryDirectory(prefix='catalog-bundle-') as folder:
                bundle = Path(folder)
                for name in ['package.json', 'package-lock.json', 'provisioner.cjs', 'credential-store.cjs', 'task.cjs']:
                    shutil.copyfile(ROOT / 'worker' / name, bundle / name)
                (bundle / 'catalog-plan.json').write_text(json.dumps(plan))
                manifest = bundle / 'manifest.json'
                manifest.write_text(json.dumps({'applications': [{
                    'name': task_name, 'memory': '256M', 'disk_quota': '512M', 'no-route': True,
                    'services': bindings, 'buildpacks': ['nodejs_buildpack'],
                    'env': {'NODE_ENV': 'production', 'CATALOG_STORE_SERVICE': specs['credentials']['name'],
                            'CATALOG_POSTGRES_SERVICE': specs['postgres']['name'], 'CATALOG_CHECK_APP': app_id or ''},
                }]}))
                print('Staging disposable task: ' + task_name, flush=True)
                self.cli('push', task_name, '--task', '-p', str(bundle), '-f', str(manifest))
                _, _, staged = self.request('/v3/apps/' + app['guid'])
                if not staged['relationships']['current_droplet']['data']:
                    raise PlatformError('Task staging did not produce a droplet')
                run_name = mode + '-' + uuid.uuid4().hex[:10]
                _, _, task = self.request('/v3/apps/' + app['guid'] + '/tasks', 'POST', {
                    'name': run_name, 'command': 'node task.cjs ' + mode, 'memory_in_mb': 256, 'disk_in_mb': 512,
                })
                deadline, next_update = time.monotonic() + 900, 0
                while time.monotonic() < deadline:
                    _, _, state = self.request('/v3/tasks/' + task['guid'])
                    if state['state'] == 'SUCCEEDED':
                        break
                    if state['state'] in ['FAILED', 'CANCELING']:
                        for marker in self.markers(self.cli('logs', task_name, '--recent', timeout=60)):
                            print('CATALOG_RESULT ' + json.dumps(marker), flush=True)
                        raise PlatformError('Provisioner task failed; inspect sanitized CATALOG_RESULT markers')
                    if time.monotonic() >= next_update:
                        print('Task pending: ' + state['state'], flush=True)
                        next_update = time.monotonic() + 30
                    time.sleep(3)
                else:
                    raise PlatformError('Provisioner task exceeded the execution deadline')
                # The task state comes from the API, not just the CLI exit code.
                for attempt in range(3):
                    logs = self.cli('logs', task_name, '--recent', timeout=60)
                    markers = self.markers(logs)
                    if any(m.get('ok') is True and m.get('mode') == mode for m in markers):
                        for marker in markers:
                            print('CATALOG_RESULT ' + json.dumps(marker), flush=True)
                        return
                    time.sleep(2)
                raise PlatformError('Task succeeded but its completion marker is missing')
        finally:
            print('Removing disposable task: ' + task_name, flush=True)
            _, headers, _ = self.request('/v3/apps/' + app['guid'], 'DELETE', missing_ok=True)
            if headers.get('Location'):
                self.wait_job(headers['Location'])
