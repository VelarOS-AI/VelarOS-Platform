"""Frozen model pricing estimates; the attributed gateway ledger remains authoritative."""

import math


RATE_FIELDS = ('input', 'cachedInput', 'cacheWriteInput', 'output', 'longThreshold',
               'longInputMultiplier', 'longOutputMultiplier')
TOKEN_FIELDS = {'input_tokens': ('inputTokens', 'input'), 'output_tokens': ('outputTokens', 'output'),
                'cache_read_tokens': ('cacheReadTokens', 'cacheRead'), 'cache_write_tokens': ('cacheWriteTokens', 'cacheWrite')}


def finite_nonnegative(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_pricing(value, model, reasoning):
    if (not isinstance(value, dict) or type(value.get('schema')) is not int or value['schema'] != 1
            or value.get('model') != model or value.get('reasoning_effort') != reasoning
            or value.get('unit') != 'USD per million tokens'
            or any(not finite_nonnegative(value.get(key)) for key in RATE_FIELDS)
            or any(not isinstance(value.get(key), str) or not value[key] for key in ('service_tier', 'source', 'verified_at'))):
        raise ValueError('Pricing must be complete, finite and frozen for this model and reasoning effort')
    return value


def token(usage, field, coverage):
    if not isinstance(usage, dict):
        return None
    evidence = usage.get('tokenCoverage')
    if isinstance(evidence, dict) and evidence.get(coverage) is False:
        return None
    value = usage.get(field)
    return value if type(value) is int and value >= 0 else None


def price_usage(usage, pricing, model, reasoning):
    try:
        rates = validate_pricing(pricing, model, reasoning)
    except ValueError:
        return None
    values = [token(usage, field, coverage) for field, coverage in TOKEN_FIELDS.values()]
    if any(value is None for value in values):
        return None
    input_tokens, output_tokens, cached, written = values
    if cached + written > input_tokens:
        return None
    long_context = input_tokens > rates['longThreshold']
    input_multiplier = rates['longInputMultiplier'] if long_context else 1
    output_multiplier = rates['longOutputMultiplier'] if long_context else 1
    return (((input_tokens - cached - written) * rates['input'] + cached * rates['cachedInput']
             + written * rates['cacheWriteInput']) * input_multiplier
            + output_tokens * rates['output'] * output_multiplier) / 1_000_000


def summarize_usage(usages, pricing, model, reasoning):
    result = {}
    for name, (field, coverage) in TOKEN_FIELDS.items():
        values = [token(usage, field, coverage) for usage in usages]
        result[name] = sum(values) if values and all(value is not None for value in values) else None
    costs = [price_usage(usage, pricing, model, reasoning) for usage in usages]
    result.update({'cost_usd': sum(costs) if costs and all(cost is not None for cost in costs) else None,
                   'known_cost_usd': sum(cost for cost in costs if cost is not None),
                   'unknown_cost_calls': sum(cost is None for cost in costs), 'observed_calls': len(usages)})
    return result


def cost_comparison(reported, calls):
    costs = [call.get('estimatedUsd') for call in calls]
    known = sum(cost for cost in costs if finite_nonnegative(cost))
    complete = all(finite_nonnegative(cost) for cost in costs)
    gateway = known if complete else None
    comparable = finite_nonnegative(reported) and gateway is not None
    return {'authority': 'gateway-request-ledger', 'basis': 'attributed requests at their frozen per-request rates',
            'reported_cost_usd': reported, 'gateway_known_cost_usd': known, 'gateway_cost_usd': gateway,
            'unknown_gateway_cost_requests': sum(not finite_nonnegative(cost) for cost in costs),
            'reported_minus_gateway_usd': reported - gateway if comparable else None,
            'matches': math.isclose(reported, gateway, rel_tol=1e-9, abs_tol=1e-9) if comparable else None}
