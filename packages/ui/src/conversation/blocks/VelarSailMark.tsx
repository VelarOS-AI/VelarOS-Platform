import { type ReactElement, useEffect, useState } from 'react'

import { StyleUtils } from '@velaros-ai/ui'

import styles from './VelarSailMark.module.css'

import { optionalWhenLazy } from '#internal/runtime'
import { type TimerLease, TimerScope } from '#internal/timerScope'

const cx = StyleUtils.bindCx(styles)

const STEADY_PULSE_DURATION_MS = 3600
const STEADY_PULSE_INTERVAL_MS = 6200

type VelarSailMarkSize = 'tiny' | 'small' | 'large' | 'splash'
type VelarSailMarkMotion = 'intro' | 'steady' | 'still'
type VelarSailMarkWindLineMotion = 'animated' | 'slide'

export type { VelarSailMarkMotion, VelarSailMarkSize, VelarSailMarkWindLineMotion }

interface VelarSailMarkProps {
  animated?: boolean
  className?: string
  decorative?: boolean
  motion?: VelarSailMarkMotion
  showWindLines?: boolean
  size?: VelarSailMarkSize
  windLineMotion?: VelarSailMarkWindLineMotion
}

function VelarSailMark({
  animated = true,
  className,
  decorative = true,
  motion = 'intro',
  showWindLines = true,
  size = 'large',
  windLineMotion = 'animated',
}: VelarSailMarkProps): ReactElement {
  const resolvedMotion: VelarSailMarkMotion = animated ? motion : 'still'
  const shouldPulseSteady = resolvedMotion === 'steady'
  const [isSteadyPulseActive, setIsSteadyPulseActive] = useState(false)
  const rootProps = {
    'aria-hidden': optionalWhenLazy(decorative, () => true),
    'aria-label': optionalWhenLazy(!decorative, () => 'VelarOS'),
    role: optionalWhenLazy(!decorative, () => 'img'),
  } as const

  useEffect(() => {
    if (!shouldPulseSteady) {
      setIsSteadyPulseActive(false)
      return
    }

    const timers = new TimerScope({ name: 'VelarSailMark.steadyPulse' })
    let stopTimer: Nullable<TimerLease> = null
    let animationFrame: Nullable<TimerLease> = null

    const playPulse = (): void => {
      stopTimer?.cancel()
      animationFrame?.cancel()
      setIsSteadyPulseActive(false)
      animationFrame = timers.nextFrame(() => {
        setIsSteadyPulseActive(true)
        stopTimer = timers.after(STEADY_PULSE_DURATION_MS, () => {
          setIsSteadyPulseActive(false)
        })
      })
    }

    playPulse()
    timers.every(STEADY_PULSE_INTERVAL_MS, playPulse)

    return () => {
      timers.dispose()
    }
  }, [shouldPulseSteady])

  if (size === 'tiny') return (
      <div
        {...rootProps}
        className={StyleUtils.cn(
          cx(
            'root',
            'tiny',
            resolvedMotion === 'intro' && 'intro',
            resolvedMotion === 'steady' && 'steady',
            shouldPulseSteady && isSteadyPulseActive && 'steadyActive',
            resolvedMotion === 'still' && 'still'
          ),
          className
        )}
      >
        <svg
          className={styles.tinySvg}
          focusable="false"
          viewBox="12 4 31 28"
        >
          <g className={styles.tinyBoat}>
            <path className={styles.tinyMast} d="M22 6 V25" />
            <path className={styles.tinySail} d="M24 7 C32 9 38 13 40 18 C34 20 29 23 24 28 Z" />
            <path className={styles.tinySailLine} d="M28 10 C27 15 27 20 25 26" />
            <path className={styles.tinyHull} d="M13 25 H37 L33 31 H17 Z" />
            <path className={styles.tinyHullLight} d="M18 27.5 H32" />
          </g>
        </svg>
      </div>
    )

  return (
    <div
      {...rootProps}
      className={StyleUtils.cn(
        cx(
          'root',
          size === 'small' && 'small',
          size === 'splash' && 'splash',
          resolvedMotion === 'intro' && 'intro',
          resolvedMotion === 'steady' && 'steady',
          showWindLines && windLineMotion === 'slide' && 'slidingWindLines',
          shouldPulseSteady && isSteadyPulseActive && 'steadyActive',
          resolvedMotion === 'still' && 'still'
        ),
        className
      )}
    >
      {showWindLines && (
        <>
          <span className={cx("windLine", "windLineOne")} />
          <span className={cx("windLine", "windLineTwo")} />
          <span className={cx("windLine", "windLineThree")} />
        </>
      )}
      <span className={styles.body}>
        <span className={styles.mast} />
        <span className={cx("sail", "mainSail")} />
        <span className={styles.hull} />
      </span>
    </div>
  )
}

export { VelarSailMark }
