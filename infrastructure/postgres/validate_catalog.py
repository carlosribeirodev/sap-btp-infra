"""Validate declarations and emit a non-secret plan. No cloud operations."""
import argparse
import json
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent


def unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key: ' + key)
        result[key] = value
    return result


def read_json(path):
    return json.loads(Path(path).read_text(), object_pairs_hook=unique_keys)


def validate_request(request, relative_path, registry, validator):
    errors = list(validator.iter_errors(request))
    if errors:
        locations = sorted({'.'.join(map(str, e.absolute_path)) or '<root>' for e in errors})
        # Avoid echoing values: a rejected file might accidentally contain a secret.
        raise ValueError('Invalid request fields: ' + ', '.join(locations))
    app = request['app_id']
    environment = request['environment']
    if Path(relative_path).as_posix() != f'{environment}/{app}.json':
        raise ValueError('Request identity must match its catalog path')
    registration = registry['applications'].get(app)
    if not registration:
        raise ValueError('Application is not registered by the platform')
    if request['owner'] != registration['owner'] or environment not in registration['environments']:
        raise ValueError('Application owner or environment is not approved')
    profile = registry['profiles'].get(request['postgres']['profile'])
    if not profile or environment not in profile['environments']:
        raise ValueError('PostgreSQL profile is not approved for this environment')
    if request['postgres']['connection_pool_max'] > profile['max_pool_connections']:
        raise ValueError('Connection pool exceeds the platform profile limit')
    if profile['isolation'] != 'database-per-app':
        raise ValueError('Unsupported isolation policy')
    sql_id = app.replace('-', '_')
    return {
        'app_id': app,
        'owner': request['owner'],
        'environment': environment,
        'source': {key: registration[key] for key in ['repository', 'source_path']},
        'postgres': {
            'profile': request['postgres']['profile'],
            'database': f'cap_lab_{environment}_{sql_id}',
            'schema': sql_id,
            'connection_pool_max': request['postgres']['connection_pool_max'],
        },
        'credential_namespaces': {
            role: f'cap-lab-{environment}-{app}-{role}' for role in ['runtime', 'deployer']
        },
        'deletion_policy': 'retain',
    }


def catalog_plan(catalog=ROOT / 'catalog'):
    catalog = Path(catalog).resolve()
    registry = read_json(ROOT / 'platform/registry.json')
    if registry.get('api_version') != 1:
        raise ValueError('Unsupported platform registry version')
    schema = read_json(ROOT / 'schemas/request.schema.json')
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    files = sorted(catalog.rglob('*.json'))
    if not files:
        raise ValueError('Catalog is empty; this command does not authorize deletion')
    plans = []
    for path in files:
        if path.is_symlink() or not path.resolve().is_relative_to(catalog):
            raise ValueError('Catalog entries must be regular files inside the catalog')
        plans.append(validate_request(read_json(path), path.relative_to(catalog), registry, validator))
    return {'mode': 'validation-only', 'applications': plans}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'catalog')
    args = parser.parse_args()
    try:
        plan = catalog_plan(args.catalog)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, 'Catalog validation failed: ' + str(error) + '\n')
    print(json.dumps(plan, indent=2))


if __name__ == '__main__':
    main()
