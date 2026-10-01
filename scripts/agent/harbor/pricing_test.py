import json
import math
import subprocess
import unittest
from pathlib import Path

from scripts.agent.harbor.pricing import cost_comparison, price_usage, summarize_usage, validate_pricing


def pricing(**changes):
    return {'schema': 1, 'model': 'fixture-model', 'reasoning_effort': 'high', 'service_tier': 'default',
            'input': 4, 'cachedInput': .4, 'cacheWriteInput': 5, 'output': 20,
            'longThreshold': 272000, 'longInputMultiplier': 2, 'longOutputMultiplier': 1.5,
            'unit': 'USD per million tokens', 'source': 'fixture://verified', 'verified_at': '2026-09-30T00:00:00Z', **changes}


class PricingTests(unittest.TestCase):
    def test_explicit_model_pricing_matches_gateway_formula_at_both_context_tiers(self):
        rates = pricing()
        gateway = {**rates, 'cached': rates['cachedInput'], 'write': rates['cacheWriteInput']}
        helper = Path(__file__).with_name('budget-proxy.mjs').resolve().as_uri()
        for count in (0, 1000, 272000, 272001):
            usage = {'inputTokens': count, 'outputTokens': 123, 'cacheReadTokens': count // 3, 'cacheWriteTokens': count // 3}
            wire = {'input_tokens': count, 'output_tokens': 123, 'input_tokens_details': {'cached_tokens': count // 3, 'cache_write_tokens': count // 3}}
            script = f'import {{usageCost}} from {json.dumps(helper)}; console.log(JSON.stringify(usageCost({json.dumps(wire)},false,{json.dumps(gateway)})))'
            expected = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', script], text=True))
            self.assertAlmostEqual(price_usage(usage, rates, 'fixture-model', 'high'), expected)

    def test_model_rate_mismatch_missing_rate_and_incomplete_usage_do_not_become_zero(self):
        complete = {'inputTokens': 100, 'outputTokens': 10, 'cacheReadTokens': 20, 'cacheWriteTokens': 30}
        self.assertIsNone(price_usage(complete, None, 'fixture-model', 'high'))
        self.assertIsNone(price_usage(complete, pricing(), 'other-model', 'high'))
        self.assertIsNone(price_usage(complete, pricing(), 'fixture-model', 'medium'))
        for field in complete:
            invalid = {k: v for k, v in complete.items() if k != field}
            self.assertIsNone(price_usage(invalid, pricing(), 'fixture-model', 'high'))
        for value in (-1, .5, True, float('nan'), float('inf')):
            self.assertIsNone(price_usage({**complete, 'inputTokens': value}, pricing(), 'fixture-model', 'high'))
        self.assertIsNone(price_usage({**complete, 'cacheReadTokens': 101}, pricing(), 'fixture-model', 'high'))
        self.assertIsNone(price_usage({**complete, 'tokenCoverage': {'cacheRead': False}}, pricing(), 'fixture-model', 'high'))
        invalid = pricing(); del invalid['output']
        self.assertIsNone(price_usage(complete, invalid, 'fixture-model', 'high'))

    def test_pricing_validation_rejects_nonfinite_negative_and_wrong_model(self):
        for change in ({'output': -1}, {'output': float('nan')}, {'output': True}, {'model': 'other'}, {'unit': 'tokens'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_pricing(pricing(**change), 'fixture-model', 'high')

    def test_partial_totals_preserve_unknown_cost_and_known_tokens(self):
        usage = {'inputTokens': 100, 'outputTokens': 10, 'cacheReadTokens': 20, 'cacheWriteTokens': 30}
        result = summarize_usage([usage, {**usage, 'cacheWriteTokens': None}], pricing(), 'fixture-model', 'high')
        self.assertEqual(result['input_tokens'], 200)
        self.assertEqual(result['output_tokens'], 20)
        self.assertIsNone(result['cost_usd'])
        self.assertEqual(result['unknown_cost_calls'], 1)
        self.assertGreater(result['known_cost_usd'], 0)
        self.assertIsNone(summarize_usage([], pricing(), 'fixture-model', 'high')['cost_usd'])

    def test_report_retains_raw_adapter_amount_and_uses_gateway_authority(self):
        comparison = cost_comparison(.5, [{'estimatedUsd': 1.0}])
        self.assertEqual(comparison['authority'], 'gateway-request-ledger')
        self.assertEqual(comparison['reported_cost_usd'], .5)
        self.assertEqual(comparison['gateway_cost_usd'], 1.)
        self.assertEqual(comparison['reported_minus_gateway_usd'], -.5)
        self.assertFalse(comparison['matches'])
        self.assertTrue(cost_comparison(.1 + .2, [{'estimatedUsd': .3}])['matches'])
        unknown = cost_comparison(.5, [{'estimatedUsd': 1.}, {'estimatedUsd': None}])
        self.assertIsNone(unknown['gateway_cost_usd'])
        self.assertIsNone(unknown['matches'])
        self.assertEqual(unknown['gateway_known_cost_usd'], 1.)
        self.assertEqual(unknown['reported_cost_usd'], .5)


if __name__ == '__main__':
    unittest.main()
