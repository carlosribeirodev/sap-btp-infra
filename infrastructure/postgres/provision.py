"""Catalog provisioner. plan is offline; bootstrap/apply/check change CF resources."""
import argparse
import json
from pathlib import Path

from cf_platform import PlatformError, load_target, session
from validate_catalog import ROOT, catalog_plan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'bootstrap', 'apply', 'check'])
    parser.add_argument('--catalog', type=Path, default=ROOT / 'catalog')
    parser.add_argument('--target', type=Path)
    args = parser.parse_args()
    try:
        planned = catalog_plan(args.catalog)
        if args.command == 'plan':
            print(json.dumps(planned, indent=2))
            return
        if not args.target:
            parser.error('--target is required for cloud operations')
        target = load_target(args.target)
        with session(target) as cf:
            cf.verify_target()
            services = {key: cf.service(spec, create=args.command == 'bootstrap') for key, spec in target['services'].items()}
            if args.command == 'bootstrap':
                print('Shared PostgreSQL and Credential Store are ready; no application allocation created.')
                return
            plan = {'api_version': 1, 'instance_guid': services['postgres']['guid'], 'applications': planned['applications']}
            if args.command == 'apply':
                cf.task(plan, 'apply')
            # Post-apply checks intentionally use one runtime-only binding at a time.
            for app in plan['applications']:
                cf.task(plan, 'check', app['app_id'])
            print('Catalog allocations and scoped runtime checks completed.')
    except (PlatformError, ValueError, KeyError, TypeError, OSError, TimeoutError) as error:
        # Detailed transport/JSON exceptions could include sensitive input.
        message = str(error) if isinstance(error, PlatformError) else type(error).__name__
        parser.exit(1, 'Provisioner failed: ' + message + '\n')


if __name__ == '__main__':
    main()
