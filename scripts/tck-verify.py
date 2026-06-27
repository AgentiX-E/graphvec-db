#!/usr/bin/env python3
"""TCK scenario pass/fail counter. Read cucumber JSON from stdin, exit 0 if all passed.

Checks that ALL steps in each scenario pass, not just the last step.
Strict: if any step fails, the scenario is counted as failed.
"""
import json, sys

data = json.load(sys.stdin)
total = passed = 0
failed_scenarios = []
for feature in data:
    for scenario in feature.get('elements', []):
        total += 1
        steps = scenario.get('steps', [])
        all_pass = True
        for step in steps:
            status = step.get('result', {}).get('status', '')
            if status not in ('passed', 'skipped', 'undefined'):
                all_pass = False
                break
        if all_pass:
            passed += 1
        else:
            failed_scenarios.append(scenario.get('name', '?')[:60])

print(f'{passed}/{total} passed ({total - passed} failed)')
if failed_scenarios and len(failed_scenarios) < 10:
    for s in failed_scenarios:
        print(f'  ✗ {s}')
sys.exit(0 if total == passed else 1)
