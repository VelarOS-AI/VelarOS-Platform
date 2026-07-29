import type { ChatInputPromptFeatureGroupOption } from '../chatInputTypes'
import {
  ChatPromptFeatureOptions,
  ChatPromptFeatureOrder,
  isOfficePromptFeature,
  NonOfficePromptFeatureOptions,
  OfficePromptFeatureIds,
  OfficePromptFeatureOptions,
} from '../chatInputUtils'

import type { ChatPromptFeatureId } from '#contracts'
import { isEmpty } from '#internal/runtime'

function clonePromptFeatureOption(
  option: ChatInputPromptFeatureGroupOption
): ChatInputPromptFeatureGroupOption {
  return {
    ...option,
    featureIds: [...option.featureIds],
  }
}

function getPromptFeatureRank(option: ChatInputPromptFeatureGroupOption): number {
  const candidateIds = !isEmpty(option.featureIds)
    ? option.featureIds
    : [option.id as ChatPromptFeatureId]
  const ranks = candidateIds.map((id) => ChatPromptFeatureOrder.indexOf(id))
  const validRanks = ranks.filter((rank) => rank >= 0)

  return !isEmpty(validRanks) ? Math.min(...validRanks) : 999_999
}

function emitOrderedFeatures(nextFeatures: Set<ChatPromptFeatureId>): ChatPromptFeatureId[] {
  return ChatPromptFeatureOrder.filter((candidate) => nextFeatures.has(candidate))
}

export function applyPromptFeatureGroupSelection(input: {
  promptFeatures: readonly ChatPromptFeatureId[]
  lockedPromptFeatures?: readonly ChatPromptFeatureId[]
  option: ChatInputPromptFeatureGroupOption
  enabled: boolean
}): ChatPromptFeatureId[] {
  const lockedPromptFeatures = input.lockedPromptFeatures ?? []
  const lockedPromptFeatureSet = new Set<ChatPromptFeatureId>(lockedPromptFeatures)
  const nextFeatures = new Set<ChatPromptFeatureId>(input.promptFeatures)
  const togglesFullOffice = input.option.featureIds.includes('office')
  if (togglesFullOffice) {
    nextFeatures.delete('office')
    OfficePromptFeatureIds.forEach((feature) => nextFeatures.delete(feature))

    if (input.enabled) {
      nextFeatures.add('office')
    }
  } else {
    const touchesOffice = input.option.featureIds.some((feature) => isOfficePromptFeature(feature))

    if (touchesOffice) {
      nextFeatures.delete('office')
    }

    input.option.featureIds.forEach((feature) => {
      if (input.enabled) {
        nextFeatures.add(feature)
      } else if (!lockedPromptFeatureSet.has(feature)) {
        nextFeatures.delete(feature)
      }
    })
  }

  lockedPromptFeatureSet.forEach((lockedFeature) => nextFeatures.add(lockedFeature))
  return emitOrderedFeatures(nextFeatures)
}

export function buildAvailablePluginOptions(
  unavailablePromptFeatures: ReadonlySet<ChatPromptFeatureId> = new Set()
): ChatInputPromptFeatureGroupOption[] {
  const topLevelOptions = ChatPromptFeatureOptions.map((option) => ({
    ...option,
    featureIds: [option.id],
  })).filter((option) => !unavailablePromptFeatures.has(option.id))

  return [
    ...topLevelOptions,
    ...OfficePromptFeatureOptions.map(clonePromptFeatureOption).filter((option) =>
      option.featureIds.every((feature) => !unavailablePromptFeatures.has(feature))
    ),
  ].sort((a, b) => getPromptFeatureRank(a) - getPromptFeatureRank(b))
}

export function buildActivePluginOptions(
  selectedPromptFeatures: ReadonlySet<ChatPromptFeatureId>
): ChatInputPromptFeatureGroupOption[] {
  const options: ChatInputPromptFeatureGroupOption[] = []

  if (selectedPromptFeatures.has('office')) {
    const officeOption = ChatPromptFeatureOptions.find((option) => option.id === 'office')

    if (officeOption) {
      options.push({
        ...officeOption,
        featureIds: ['office'],
      })
    }
  } else {
    for (const option of OfficePromptFeatureOptions) {
      if (option.featureIds.some((featureId) => selectedPromptFeatures.has(featureId))) {
        options.push(clonePromptFeatureOption(option))
      }
    }
  }

  for (const option of NonOfficePromptFeatureOptions) {
    if (selectedPromptFeatures.has(option.id)) {
      options.push({
        ...option,
        featureIds: [option.id],
      })
    }
  }

  return options.sort((a, b) => getPromptFeatureRank(a) - getPromptFeatureRank(b))
}
