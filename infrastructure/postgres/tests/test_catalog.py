import copy
import json
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import validate_catalog as catalog
from jsonschema import Draft202012Validator


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.request = catalog.read_json(catalog.ROOT / 'catalog/dev/requests.json')
        self.registry = catalog.read_json(catalog.ROOT / 'platform/registry.json')
        self.validator = Draft202012Validator(catalog.read_json(catalog.ROOT / 'schemas/request.schema.json'))

    def validate(self, request):
        return catalog.validate_request(request, 'dev/requests.json', self.registry, self.validator)

    def test_two_apps_receive_distinct_databases_and_scoped_namespaces(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'dev').mkdir()
            for app in ['requests', 'assets']:
                shutil.copyfile(catalog.ROOT / f'catalog/dev/{app}.json', root / f'dev/{app}.json')
            plan = catalog.catalog_plan(root)
        apps = plan['applications']
        self.assertEqual(plan['mode'], 'validation-only')
        self.assertEqual({a['app_id'] for a in apps}, {'requests', 'assets'})
        self.assertEqual(len({a['postgres']['database'] for a in apps}), 2)
        self.assertEqual(len({n for a in apps for n in a['credential_namespaces'].values()}), 4)

    def test_registered_third_application_is_accepted_without_changing_existing_allocations(self):
        existing = [app for app in catalog.catalog_plan()['applications'] if app['app_id'] != 'pedidos']
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ['platform', 'schemas', 'catalog/dev']:
                (root / name).mkdir(parents=True, exist_ok=True)
            registry = json.loads(json.dumps(self.registry))
            registry['applications']['pedidos'] = {
                'owner': 'lab', 'repository': 'example/pedidos',
                'source_path': '.', 'environments': ['dev'],
            }
            (root / 'platform/registry.json').write_text(json.dumps(registry))
            shutil.copyfile(catalog.ROOT / 'schemas/request.schema.json', root / 'schemas/request.schema.json')
            for source in (catalog.ROOT / 'catalog/dev').glob('*.json'):
                shutil.copyfile(source, root / 'catalog/dev' / source.name)
            request = dict(self.request, app_id='pedidos')
            (root / 'catalog/dev/pedidos.json').write_text(json.dumps(request))
            with patch.object(catalog, 'ROOT', root):
                apps = catalog.catalog_plan(root / 'catalog')['applications']
        self.assertEqual([app for app in apps if app['app_id'] != 'pedidos'], existing)
        added = next(app for app in apps if app['app_id'] == 'pedidos')
        self.assertEqual(added['postgres']['database'], 'cap_lab_dev_pedidos')
        self.assertEqual(added['postgres']['schema'], 'pedidos')
        self.assertEqual(added['credential_namespaces']['runtime'], 'cap-lab-dev-pedidos-runtime')

    def test_cannot_select_another_apps_identity_through_existing_file(self):
        self.request['app_id'] = 'assets'
        with self.assertRaisesRegex(ValueError, 'catalog path'):
            self.validate(self.request)

    def test_rejects_unapproved_owner_and_profile_and_pool(self):
        for change in ['owner', 'profile', 'pool']:
            with self.subTest(change=change):
                request = copy.deepcopy(self.request)
                if change == 'owner': request['owner'] = 'finance'
                if change == 'profile': request['postgres']['profile'] = 'production'
                if change == 'pool': request['postgres']['connection_pool_max'] = 6
                with self.assertRaises(ValueError): self.validate(request)

    def test_rejects_embedded_secrets_sql_and_privilege_requests_without_echoing(self):
        for field in ['password', 'sql', 'superuser']:
            with self.subTest(field=field):
                request = copy.deepcopy(self.request)
                request['postgres'][field] = 'SYNTHETIC_SENTINEL'
                with self.assertRaises(ValueError) as result: self.validate(request)
                self.assertNotIn('SYNTHETIC_SENTINEL', str(result.exception))

    def test_rejects_production_and_automatic_destruction(self):
        for field, value in [('environment', 'prod'), ('deletion_policy', 'delete')]:
            with self.subTest(field=field):
                request = copy.deepcopy(self.request)
                if field == 'environment': request[field] = value
                else: request['lifecycle'][field] = value
                with self.assertRaises(ValueError): self.validate(request)

    def test_rejects_path_traversal_sql_identifiers_and_boolean_pool(self):
        for value in ['../assets', 'requests;DROP DATABASE x', 'requests_assets']:
            with self.subTest(value=value):
                self.request['app_id'] = value
                with self.assertRaises(ValueError): self.validate(self.request)
        self.request['app_id'] = 'requests'
        self.request['postgres']['connection_pool_max'] = True
        with self.assertRaises(ValueError): self.validate(self.request)

    def test_duplicate_json_keys_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'request.json'
            path.write_text('{"app_id":"requests","app_id":"assets"}')
            with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'): catalog.read_json(path)

    def test_empty_catalog_does_not_generate_a_delete_plan(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'does not authorize deletion'): catalog.catalog_plan(folder)

    def test_rejects_symlinked_catalog_entry(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'dev').mkdir()
            (root / 'dev/requests.json').symlink_to(catalog.ROOT / 'catalog/dev/requests.json')
            with self.assertRaisesRegex(ValueError, 'regular files'): catalog.catalog_plan(root)


if __name__ == '__main__':
    unittest.main()
