import { expect, test } from 'bun:test'

import { ContextPlanner } from '../src/impl/ContextPlanner.js'
import { ContextPlanTuning } from '../src/utils/tuning.js'

const segment = (id = 'a', revision = 0) => ({ id, index: 1, revision, volumes: 0, turns: 0 })

test('INV-40 calibration starts at the raw estimate, learns only from text requests and resets on rejection', () => {
  const planner = new ContextPlanner({ foldTurns: 2, minTurns: 4 })
  expect(planner.calibration()).toEqual({ textRatio: 1 })
  planner.measure({ text: 10_000, images: 0 }, 3_000)
  planner.measure({ text: 10_000, images: 0 }, 2_000)
  // 图片的真实开销因供应商而异，带图请求不取样
  planner.measure({ text: 10_000, images: 2_000 }, 9_000)
  // 不透明推理状态可能只被供应商部分采用，不能拿它误学成文本密度。
  planner.measure({ text: 10_000, images: 0, opaque: 5_000 }, 9_000)
  expect(planner.calibration().textRatio).toBeCloseTo(0.3 * ContextPlanTuning.calibrationMargin)
  // 实测比原始估算还大时不放大：原始估算是上界
  planner.measure({ text: 1_000, images: 0 }, 5_000)
  expect(planner.calibration()).toEqual({ textRatio: 1 })
  planner.rejected()
  expect(planner.calibration()).toEqual({ textRatio: 1 })
})

test('growth comes from positive increases inside one segment base and drives the runway', () => {
  const planner = new ContextPlanner({ foldTurns: 2, minTurns: 4 })
  expect(planner.growth(100_000)).toBe(100_000 * ContextPlanTuning.growthSeed)
  planner.accept(10_000, segment())
  planner.accept(11_000, segment())
  planner.accept(12_500, segment())
  // 底座重建或换段后的差值不能当成增长
  planner.accept(30_000, segment('a', 1))
  planner.accept(5_000, segment('b'))
  planner.accept(4_000, segment('b'))
  expect(planner.growth(100_000)).toBe(1_500)
  expect(planner.runway(97_000, 100_000)).toBe(2)
})

test('INV-40 growth is sampled per layout: frames that keep earlier frames never inflate the plain runway', () => {
  const planner = new ContextPlanner({ foldTurns: 2, minTurns: 4 })
  planner.accept(10_000, segment(), true)
  planner.accept(14_000, segment(), true)
  planner.accept(18_000, segment(), true)
  // 切换布局的那一帧不取样，之后两种布局各自取样
  planner.accept(12_000, segment())
  planner.accept(12_500, segment())
  planner.accept(13_000, segment())
  expect(planner.growth(100_000, true)).toBe(4_000)
  expect(planner.growth(100_000)).toBe(500)
  expect(planner.runway(90_000, 100_000)).toBe(20)
  expect(planner.runway(90_000, 100_000, true)).toBe(2.5)
})

test('folds closer than foldTurns frames count as thrashing until minTurns frames pass', () => {
  const planner = new ContextPlanner({ foldTurns: 2, minTurns: 4 })
  planner.folded()
  expect(planner.thrashing()).toBe(false)
  planner.accept(1_000, segment())
  planner.folded()
  expect(planner.thrashing()).toBe(true)
  for (let frame = 0; frame < 4; frame++) planner.accept(1_000, segment('c'))
  expect(planner.thrashing()).toBe(false)
})

test('maintenance that did not help is spent for its segment only', () => {
  const planner = new ContextPlanner({ foldTurns: 2, minTurns: 4 })
  expect(planner.exhausted('a')).toBe(false)
  planner.exhaust('a')
  expect(planner.exhausted('a')).toBe(true)
  expect(planner.exhausted('b')).toBe(false)
})

test('the projection budget follows the median character density and never exceeds the ceiling', () => {
  const planner = new ContextPlanner({ foldTurns: 2, minTurns: 4 })
  expect(planner.chars(10_000, 1_000_000)).toBe(1_000_000)
  planner.density(30_000, 10_000)
  planner.density(10_000, 10_000)
  planner.density(20_000, 10_000)
  expect(planner.chars(10_000, 1_000_000)).toBe(20_000)
  expect(planner.chars(10_000, 15_000)).toBe(15_000)
})
