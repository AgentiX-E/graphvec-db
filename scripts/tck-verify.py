#!/usr/bin/env python3
"""TCK scenario pass/fail counter. Read cucumber JSON from stdin, exit 0 if all passed."""
import json, sys

data = json.load(sys.stdin)
total = passed = 0
for feature in data:
    for scenario in feature.get('elements', []):
        total += 1
        steps = scenario.get('steps', [])
        status = steps[-1].get('result', {}).get('status', '') if steps else ''
        if status == 'passed':
            passed += 1

print(f'{passed}/{total} passed')
sys.exit(0 if total == passed else 1)
