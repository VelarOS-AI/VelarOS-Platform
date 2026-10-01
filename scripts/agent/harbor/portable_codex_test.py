"""Offline native-to-ATIF accounting regressions; synthetic usage, no CLI or model requests."""
import copy
import json
import logging
from pathlib import Path
import tempfile
import unittest

from harbor.agents.installed.codex import Codex
from scripts.agent.harbor.portable_codex import PortableCodex


def usage(inputs=100,outputs=10,cached=20):
    return {'input_tokens':inputs,'output_tokens':outputs,'cached_input_tokens':cached,
            'cache_write_input_tokens':0,'reasoning_output_tokens':0,'total_tokens':inputs+outputs}


def plus(left,right):return {key:left[key]+right[key] for key in left}


def events(calls):
    result=[{'type':'session_meta','payload':{'id':'synthetic-session','cli_version':'0.158.0'}},
            {'type':'turn_context','payload':{'model':'synthetic-model','turn_id':'turn'}}]
    for index,(total,last) in enumerate(calls):
        result += [{'timestamp':f'2030-01-01T00:00:{index:02d}Z','type':'response_item',
                    'payload':{'type':'message','role':'assistant','content':[{'type':'output_text','text':f'answer-{index}'}]}},
                   {'type':'event_msg','payload':{'type':'token_count','info':{'total_token_usage':total,'last_token_usage':last}}}]
    return result


def adapter(cls=PortableCodex):
    item=object.__new__(cls)
    item.model_name='synthetic-model';item._version='0.158.0';item.logger=logging.getLogger('codex-usage-test')
    item._compute_cost_from_pricing=lambda prompt_tokens,completion_tokens,cached_tokens,cache_write_tokens,model_name=None: ((prompt_tokens or 0)-(cached_tokens or 0))*4e-6+(cached_tokens or 0)*.4e-6+(completion_tokens or 0)*20e-6
    return item


def convert(raw,cls=PortableCodex):
    with tempfile.TemporaryDirectory(prefix='codex-usage-fixture-') as directory:
        path=Path(directory)/'rollout-synthetic.jsonl'
        original=''.join(json.dumps(event)+'\n' for event in raw)
        path.write_text(original)
        result=adapter(cls)._convert_events_to_trajectory(Path(directory))
        if path.read_text()!=original:raise AssertionError('Native transcript was modified')
        if sorted(p.name for p in Path(directory).iterdir())!=[path.name]:raise AssertionError('Derived transcript leaked')
        return result


class PortableCodexUsageTests(unittest.TestCase):
    def test_interruption_repeats_snapshot_without_rebilling_partial_output(self):
        first=usage();second=usage(200,30,100)
        result=convert(events([(first,first),(first,first),(plus(first,second),second)]))
        steps=[s for s in result.steps if s.source=='agent']
        self.assertEqual(len(steps),3)
        self.assertIsNone(steps[1].metrics)
        self.assertEqual(sum(s.metrics.prompt_tokens for s in steps if s.metrics),300)
        self.assertEqual(result.final_metrics.total_prompt_tokens,300)
        self.assertIsNone(result.final_metrics.total_cost_usd)
        accounting=result.final_metrics.extra['native_usage_accounting']
        self.assertEqual(accounting['unmeasured_call_groups'],1)
        self.assertAlmostEqual(accounting['known_estimated_cost_usd'],.001568)

    def test_two_equal_usage_calls_with_advancing_totals_both_count(self):
        first=usage();result=convert(events([(first,first),(plus(first,first),first)]))
        self.assertEqual([s.metrics.prompt_tokens for s in result.steps if s.source=='agent'],[100,100])
        self.assertAlmostEqual(result.final_metrics.total_cost_usd,.001056)
        self.assertEqual(result.final_metrics.extra['native_usage_accounting']['unmeasured_call_groups'],0)

    def test_counter_reset_does_not_reanchor_or_erase_steps(self):
        first=usage(200,20,40);reset=usage();third=usage(150,15,30)
        result=convert(events([(first,first),(reset,reset),(plus(reset,third),third)]))
        steps=[s for s in result.steps if s.source=='agent']
        self.assertEqual(len(steps),3);self.assertIsNone(steps[1].metrics)
        self.assertIsNone(steps[2].metrics)
        self.assertIsNone(result.final_metrics.total_cost_usd)

    def test_regression_or_malformed_snapshot_cannot_rebill_the_high_watermark(self):
        first=usage();zero=usage(0,0,0);bad=usage();bad['input_tokens']=True
        changed={key:value for key,value in first.items() if key!='reasoning_output_tokens'}
        for middle in [None,zero,usage(50,5,10),bad,changed]:
            with self.subTest(middle=middle):
                result=convert(events([(first,first),(middle,middle),(first,first),(plus(first,first),first)]))
                steps=[s for s in result.steps if s.source=='agent']
                self.assertEqual([s.metrics.prompt_tokens if s.metrics else None for s in steps],[100,None,None,100])
                self.assertEqual(result.final_metrics.extra['native_usage_accounting']['unmeasured_call_groups'],2)

    def test_first_missing_snapshot_requires_a_valid_baseline_before_accounting(self):
        first=usage();result=convert(events([(None,None),(first,first),(plus(first,first),first)]))
        self.assertEqual([s.metrics.prompt_tokens if s.metrics else None for s in result.steps if s.source=='agent'],[None,None,100])

    def test_unknown_price_retains_known_subtotal_but_no_complete_total(self):
        with tempfile.TemporaryDirectory(prefix='codex-usage-price-') as directory:
            raw=events([(usage(),usage()),(usage(300,30,60),usage(200,20,40))])
            raw[-1]['payload']['info']['total_cost']=123
            (Path(directory)/'rollout.jsonl').write_text(''.join(json.dumps(e)+'\n' for e in raw))
            item=adapter();price=item._compute_cost_from_pricing
            item._compute_cost_from_pricing=lambda **kwargs: None if kwargs['prompt_tokens']==200 else price(**kwargs)
            result=item._convert_events_to_trajectory(Path(directory))
        self.assertIsNone(result.final_metrics.total_cost_usd)
        accounting=result.final_metrics.extra['native_usage_accounting']
        self.assertEqual(accounting['unknown_price_call_groups'],1)
        self.assertAlmostEqual(accounting['known_estimated_cost_usd'],.000528)

    def test_missing_counter_cannot_make_an_old_snapshot_new_again(self):
        first=usage();second=usage(200,20,40)
        result=convert(events([(first,first),(None,None),(first,first),(plus(first,second),second)]))
        steps=[s for s in result.steps if s.source=='agent']
        self.assertEqual([s.metrics.prompt_tokens if s.metrics else None for s in steps],[100,None,None,200])
        self.assertEqual(result.final_metrics.extra['native_usage_accounting']['unmeasured_call_groups'],2)

    def test_invalid_usage_is_not_replaced_with_zero(self):
        for field,value in [('input_tokens',True),('output_tokens',-1),('cached_input_tokens',101),('total_tokens',999),('reasoning_output_tokens',11)]:
            with self.subTest(field=field,value=value):
                bad=usage();bad[field]=value
                result=convert(events([(bad,bad)]))
                self.assertIsNone(next(s for s in result.steps if s.source=='agent').metrics)
                self.assertIsNone(result.final_metrics.total_cost_usd)

    def test_missing_last_usage_keeps_the_call_unknown(self):
        result=convert(events([(usage(),None)]))
        self.assertIsNone(next(s for s in result.steps if s.source=='agent').metrics)
        self.assertIsNone(result.final_metrics.total_cost_usd)

    def test_larger_cumulative_delta_does_not_charge_last_to_unproven_group(self):
        first=usage();last=usage(200,20,40)
        result=convert(events([(first,first),(plus(plus(first,last),last),last)]))
        self.assertIsNone([s for s in result.steps if s.source=='agent'][1].metrics)

    def test_first_inherited_total_does_not_assign_prior_usage(self):
        last=usage();result=convert(events([(plus(last,last),last)]))
        self.assertIsNone(next(s for s in result.steps if s.source=='agent').metrics)

    def test_no_output_counter_can_establish_a_baseline(self):
        first=usage();next_usage=usage(200,20,40)
        raw=events([(first,first),(plus(first,next_usage),next_usage)])
        del raw[2]
        result=convert(raw)
        steps=[s for s in result.steps if s.source=='agent']
        self.assertEqual(len(steps),1);self.assertEqual(steps[0].metrics.prompt_tokens,200)

    def test_unfinished_partial_output_is_preserved_without_metrics(self):
        raw=events([(usage(),usage())]);raw=raw[:-1]
        result=convert(raw)
        self.assertEqual(next(s for s in result.steps if s.source=='agent').message,'answer-0')
        self.assertIsNone(next(s for s in result.steps if s.source=='agent').metrics)

    def test_explicit_zero_usage_cost_remains_zero(self):
        zero=usage(0,0,0);result=convert(events([(zero,zero)]))
        self.assertEqual(result.final_metrics.total_cost_usd,0)
        self.assertEqual(result.final_metrics.extra['native_usage_accounting']['unmeasured_call_groups'],0)

    def test_known_cache_write_and_long_request_price_inputs_are_unchanged(self):
        u=usage(500000,100,200000);u['cache_write_input_tokens']=100
        result=convert(events([(u,u)]));metrics=next(s for s in result.steps if s.source=='agent').metrics
        self.assertEqual(metrics.prompt_tokens,500000)
        self.assertEqual(metrics.cached_tokens,200000)
        self.assertEqual(metrics.extra['cache_write_input_tokens'],100)

    def test_latest_rollout_selection_and_separate_conversions_keep_native_identity(self):
        with tempfile.TemporaryDirectory(prefix='codex-usage-selection-') as directory:
            folder=Path(directory)
            for name,n in [('rollout-a.jsonl',100),('rollout-z.jsonl',200)]:
                (folder/name).write_text(''.join(json.dumps(e)+'\n' for e in events([(usage(n,10,20),usage(n,10,20))])))
            item=adapter()
            for _ in range(2):
                result=item._convert_events_to_trajectory(folder)
                self.assertEqual(result.final_metrics.total_prompt_tokens,200)
                self.assertEqual(result.session_id,'synthetic-session')

    def test_incomplete_stream_preserves_tool_call_and_result_without_rebilling(self):
        u=usage();raw=events([(u,u),(u,u)])
        raw[4]['payload']={'type':'function_call','call_id':'call-1','name':'read','arguments':'{}'}
        raw.insert(5,{'type':'response_item','payload':{'type':'function_call_output','call_id':'call-1','output':'synthetic-result'}})
        result=convert(raw);steps=[s for s in result.steps if s.source=='agent']
        self.assertIsNone(steps[1].metrics)
        self.assertEqual(steps[1].tool_calls[0].function_name,'read')
        self.assertIn('synthetic-result',str(steps[1].observation))


if __name__=='__main__':unittest.main(verbosity=2)
