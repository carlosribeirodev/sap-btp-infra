import contextlib
import copy
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cf_platform as platform
import provision
from validate_catalog import catalog_plan

ROOT = Path(__file__).resolve().parents[1]


class PlatformTests(unittest.TestCase):
    def setUp(self):
        self.target = json.loads((ROOT / 'platform/target.example.json').read_text())
        self.target.update(api='https://api.example.invalid', org='test-org')
        self.cf = platform.CloudFoundry(self.target, {'SpaceFields': {'GUID': 'space-guid'}}, Path('/unused'))

    def test_mvp_refuses_paid_fallback_and_unexpected_targets(self):
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'target.json'
            for variant in ['valid', 'paid', 'other-service', 'credential-url', 'prod']:
                target = copy.deepcopy(self.target)
                if variant == 'paid': target['services']['postgres']['plan'] = 'standard'
                if variant == 'other-service': target['services']['postgres']['name'] = 'somebody-elses-db'
                if variant == 'credential-url': target['api'] = 'https://user:sentinel@example.invalid'
                if variant == 'prod': target['space'] = 'prod'
                file.write_text(json.dumps(target))
                with self.subTest(variant=variant):
                    if variant == 'valid': self.assertEqual(platform.load_target(file), target)
                    else:
                        with self.assertRaises(platform.PlatformError) as error: platform.load_target(file)
                        self.assertNotIn('sentinel', str(error.exception))

    def test_missing_service_does_not_trigger_implicit_creation(self):
        self.cf.resources = lambda path: []
        with patch.object(self.cf, 'request') as request:
            with self.assertRaisesRegex(platform.PlatformError, 'bootstrap first'):
                self.cf.service(self.target['services']['postgres'])
            request.assert_not_called()

    def test_service_name_is_not_enough_to_adopt_existing_resources(self):
        self.cf.resources = lambda path: [{'guid': 'existing'}]
        self.cf.request = lambda path: (200, {}, {'guid': 'existing', 'metadata': {'labels': {}}, 'relationships': {'space': {'data': {'guid': 'space-guid'}}}})
        with self.assertRaisesRegex(platform.PlatformError, 'Refusing to adopt'):
            self.cf.service(self.target['services']['postgres'])

    def test_job_failure_is_not_reported_as_success(self):
        self.cf.request = lambda path: (200, {}, {'state': 'FAILED'})
        with self.assertRaisesRegex(platform.PlatformError, 'operation failed'): self.cf.wait_job('/v3/jobs/job')

    def test_async_service_creation_can_return_an_empty_body_and_is_resolved_by_name(self):
        labels = {'managed_by': platform.MANAGED_BY, 'profile': 'shared-dev'}
        service = {'guid': 'new-service', 'metadata': {'labels': labels}, 'relationships': {
            'space': {'data': {'guid': 'space-guid'}}, 'service_plan': {'data': {'guid': 'trial-plan'}}},
            'last_operation': {'type': 'create', 'state': 'succeeded'}}
        created = False

        def resources(path):
            if path.startswith('/v3/service_instances?'): return [service] if created else []
            if path.startswith('/v3/service_offerings?'): return [{'guid': 'offer'}]
            return [{'guid': 'trial-plan'}]

        def request(path, method='GET', body=None):
            nonlocal created
            if method == 'POST':
                created = True
                self.assertEqual(body['metadata']['labels'], labels)
                return 202, {'Location': '/v3/jobs/create'}, None
            if path.startswith('/v3/service_instances/'): return 200, {}, service
            if path.startswith('/v3/service_plans/'): return 200, {}, {'name': 'trial', 'relationships': {'service_offering': {'data': {'guid': 'offer'}}}}
            return 200, {}, {'name': 'postgresql-db'}

        self.cf.resources, self.cf.request = resources, request
        with patch.object(self.cf, 'wait_job') as wait:
            self.assertEqual(self.cf.service(self.target['services']['postgres'], create=True)['guid'], 'new-service')
            wait.assert_called_once_with('/v3/jobs/create')

    def test_check_task_has_only_scoped_vault_access_and_cleans_up_after_push_failure(self):
        plan = {'api_version': 1, 'instance_guid': '11111111-1111-4111-8111-111111111111', 'applications': catalog_plan()['applications']}
        calls, manifests = [], []

        def request(path, method='GET', body=None, missing_ok=False):
            calls.append((path, method, body))
            if method == 'POST': return 201, {}, {'guid': 'owned-task'}
            return 204, {}, None

        def cli(*args, **kwargs):
            manifests.append(json.loads(Path(args[args.index('-f') + 1]).read_text()))
            raise platform.PlatformError('simulated staging failure')

        self.cf.request, self.cf.cli = request, cli
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(platform.PlatformError, 'staging failure'): self.cf.task(plan, 'check', 'requests')
        services = manifests[0]['applications'][0]['services']
        self.assertEqual(len(services), 1)
        auth = services[0]['parameters']['authorization']
        self.assertEqual(auth, {'default_permissions': [], 'namespace_permissions': {'cap-lab-dev-requests-runtime': ['read']}})
        self.assertEqual(calls[-1][:2], ('/v3/apps/owned-task', 'DELETE'))

    def test_apply_task_includes_admin_but_does_not_write_credentials_to_bundle(self):
        plan = {'api_version': 1, 'instance_guid': '11111111-1111-4111-8111-111111111111', 'applications': catalog_plan()['applications']}
        captured = {}
        self.cf.request = lambda path, method='GET', body=None, missing_ok=False: (201, {}, {'guid': 'owned-task'}) if method == 'POST' else (204, {}, None)

        def cli(*args, **kwargs):
            file = Path(args[args.index('-f') + 1])
            captured['manifest'] = json.loads(file.read_text())
            captured['plan'] = json.loads((file.parent / 'catalog-plan.json').read_text())
            raise platform.PlatformError('stop before staging')

        self.cf.cli = cli
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(platform.PlatformError): self.cf.task(plan, 'apply')
        self.assertEqual(captured['plan'], plan)
        services = captured['manifest']['applications'][0]['services']
        self.assertEqual(services[0]['name'], 'cap-lab-dev-postgres')
        self.assertEqual(set(services[1]['parameters']['authorization']['namespace_permissions']), {
            namespace for app in plan['applications'] for namespace in app['credential_namespaces'].values()
        })
        self.assertNotIn('password', json.dumps(captured))

    def test_plan_never_accesses_cf_or_the_login_profile(self):
        with patch.object(sys, 'argv', ['provision.py', 'plan']), patch.object(provision, 'session') as session, contextlib.redirect_stdout(io.StringIO()) as output:
            provision.main()
            session.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['applications'], catalog_plan()['applications'])

    def test_redirects_are_refused_instead_of_forwarding_authorization(self):
        self.assertIsNone(platform.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.invalid'))


if __name__ == '__main__':
    unittest.main()
