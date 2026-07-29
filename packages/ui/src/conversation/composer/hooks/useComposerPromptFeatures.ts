import { useCallback, useEffect, useMemo } from 'react'

import type { ChatInputPromptFeatureGroupOption } from '../chatInputTypes'
import {
  ChatPromptFeatureOrder,
  isOfficePromptFeature,
  OfficePromptFeatureIds,
} from '../chatInputUtils'

import {
  applyPromptFeatureGroupSelection,
  buildActivePluginOptions,
  buildAvailablePluginOptions,
} from './useComposerPromptFeatures.pure'

import type { ChatPromptFeatureId } from '#contracts'

interface UseComposerPromptFeaturesArgs {
  promptFeatures: ChatPromptFeatureId[]
  lockedPromptFeatures?: ChatPromptFeatureId[]
  onPromptFeaturesChange?: (features: ChatPromptFeatureId[]) => void
  unavailablePromptFeatures?: ReadonlySet<ChatPromptFeatureId>
  resourceAvailabilityResolved?: boolean
}

interface UseComposerPromptFeaturesResult {
  selectedPromptFeatures: ReadonlySet<ChatPromptFeatureId>
  pluginOptions: ChatInputPromptFeatureGroupOption[]
  activePluginOptions: ChatInputPromptFeatureGroupOption[]
  hasOfficeFeatureSelected: boolean
  updatePromptFeature: (feature: ChatPromptFeatureId, enabled: boolean) => void
  updateExclusivePromptFeature: (
    feature: ChatPromptFeatureId,
    excludedFeatures: readonly ChatPromptFeatureId[],
    enabled: boolean
  ) => void
  updatePromptFeatureGroup: (option: ChatInputPromptFeatureGroupOption, enabled: boolean) => void
}

const EmptyLockedPromptFeatures: ChatPromptFeatureId[] = []
const EmptyUnavailablePromptFeatures = new Set<ChatPromptFeatureId>()

function emitOrderedFeatures(nextFeatures: Set<ChatPromptFeatureId>): ChatPromptFeatureId[] {
  return ChatPromptFeatureOrder.filter((candidate) => nextFeatures.has(candidate))
}

function buildPromptFeatureSet(
  promptFeatures: readonly ChatPromptFeatureId[],
  lockedPromptFeatures: readonly ChatPromptFeatureId[],
  unavailablePromptFeatures: ReadonlySet<ChatPromptFeatureId>
): Set<ChatPromptFeatureId> {
  const nextFeatures = new Set<ChatPromptFeatureId>()
  promptFeatures.forEach((feature) => nextFeatures.add(feature))
  lockedPromptFeatures.forEach((feature) => nextFeatures.add(feature))
  unavailablePromptFeatures.forEach((feature) => nextFeatures.delete(feature))
  return nextFeatures
}

export function useComposerPromptFeatures({
  promptFeatures,
  lockedPromptFeatures = EmptyLockedPromptFeatures,
  onPromptFeaturesChange,
  unavailablePromptFeatures = EmptyUnavailablePromptFeatures,
  resourceAvailabilityResolved = true,
}: UseComposerPromptFeaturesArgs): UseComposerPromptFeaturesResult {
  const lockedPromptFeatureSet = useMemo(
    () => new Set<ChatPromptFeatureId>(lockedPromptFeatures),
    [lockedPromptFeatures]
  )
  const selectedPromptFeatures = useMemo(
    () => buildPromptFeatureSet(promptFeatures, lockedPromptFeatures, unavailablePromptFeatures),
    [lockedPromptFeatures, promptFeatures, unavailablePromptFeatures]
  )

  const activePluginOptions = useMemo(
    () => buildActivePluginOptions(selectedPromptFeatures),
    [selectedPromptFeatures]
  )
  const pluginOptions = useMemo(
    () => buildAvailablePluginOptions(unavailablePromptFeatures),
    [unavailablePromptFeatures]
  )

  useEffect(() => {
    if (!resourceAvailabilityResolved || !onPromptFeaturesChange) return
    const nextFeatureSet = buildPromptFeatureSet(
      promptFeatures,
      EmptyLockedPromptFeatures,
      unavailablePromptFeatures
    )
    const nextFeatures = emitOrderedFeatures(nextFeatureSet)
    if (
      nextFeatures.length === promptFeatures.length &&
      nextFeatures.every((feature, index) => feature === promptFeatures[index])
    )
      return
    onPromptFeaturesChange(nextFeatures)
  }, [
    onPromptFeaturesChange,
    promptFeatures,
    resourceAvailabilityResolved,
    unavailablePromptFeatures,
  ])

  const hasOfficeFeatureSelected = useMemo(
    () =>
      selectedPromptFeatures.has('office') ||
      OfficePromptFeatureIds.some((feature) => selectedPromptFeatures.has(feature)),
    [selectedPromptFeatures]
  )

  const updatePromptFeature = useCallback(
    (feature: ChatPromptFeatureId, enabled: boolean): void => {
      if (!onPromptFeaturesChange) return
      if (unavailablePromptFeatures.has(feature)) return

      if (!enabled && lockedPromptFeatureSet.has(feature)) return

      const nextFeatures = buildPromptFeatureSet(
        promptFeatures,
        lockedPromptFeatures,
        unavailablePromptFeatures
      )

      if (feature === 'office') {
        if (enabled) {
          OfficePromptFeatureIds.forEach((officeFeature) => nextFeatures.delete(officeFeature))
          nextFeatures.add('office')
        } else {
          nextFeatures.delete('office')
          OfficePromptFeatureIds.forEach((officeFeature) => nextFeatures.delete(officeFeature))
        }
      } else if (isOfficePromptFeature(feature)) {
        const hadFullOffice = nextFeatures.has('office')
        nextFeatures.delete('office')

        if (enabled) {
          if (hadFullOffice) {
            OfficePromptFeatureIds.forEach((officeFeature) => nextFeatures.delete(officeFeature))
          }
          nextFeatures.add(feature)
        } else {
          nextFeatures.delete(feature)
        }
      } else if (enabled) {
        nextFeatures.add(feature)
      } else {
        nextFeatures.delete(feature)
      }

      lockedPromptFeatureSet.forEach((lockedFeature) => nextFeatures.add(lockedFeature))
      onPromptFeaturesChange(emitOrderedFeatures(nextFeatures))
    },
    [
      lockedPromptFeatureSet,
      lockedPromptFeatures,
      onPromptFeaturesChange,
      promptFeatures,
      unavailablePromptFeatures,
    ]
  )

  const updatePromptFeatureGroup = useCallback(
    (option: ChatInputPromptFeatureGroupOption, enabled: boolean): void => {
      if (!onPromptFeaturesChange) return

      const nextFeatures = applyPromptFeatureGroupSelection({
        promptFeatures,
        lockedPromptFeatures,
        option,
        enabled,
      }).filter((feature) => !unavailablePromptFeatures.has(feature))
      onPromptFeaturesChange(nextFeatures)
    },
    [lockedPromptFeatures, onPromptFeaturesChange, promptFeatures, unavailablePromptFeatures]
  )

  const updateExclusivePromptFeature = useCallback(
    (
      feature: ChatPromptFeatureId,
      excludedFeatures: readonly ChatPromptFeatureId[],
      enabled: boolean
    ): void => {
      if (!onPromptFeaturesChange) return
      if (unavailablePromptFeatures.has(feature)) return

      const nextFeatures = buildPromptFeatureSet(
        promptFeatures,
        lockedPromptFeatures,
        unavailablePromptFeatures
      )
      if (enabled) {
        excludedFeatures.forEach((excluded) => {
          if (!lockedPromptFeatureSet.has(excluded)) nextFeatures.delete(excluded)
        })
        nextFeatures.add(feature)
      } else if (!lockedPromptFeatureSet.has(feature)) {
        nextFeatures.delete(feature)
      }
      lockedPromptFeatureSet.forEach((lockedFeature) => nextFeatures.add(lockedFeature))
      onPromptFeaturesChange(emitOrderedFeatures(nextFeatures))
    },
    [
      lockedPromptFeatureSet,
      lockedPromptFeatures,
      onPromptFeaturesChange,
      promptFeatures,
      unavailablePromptFeatures,
    ]
  )

  return {
    selectedPromptFeatures,
    pluginOptions,
    activePluginOptions,
    hasOfficeFeatureSelected,
    updatePromptFeature,
    updateExclusivePromptFeature,
    updatePromptFeatureGroup,
  }
}
