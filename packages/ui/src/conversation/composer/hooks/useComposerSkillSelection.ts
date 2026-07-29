import { useCallback } from 'react'

interface SkillLike {
  id: string
}

interface UseComposerSkillSelectionArgs {
  availableSkills: readonly SkillLike[]
  selectedSkillIds: readonly string[]
  onSelectedSkillIdsChange?: (skillIds: string[]) => void
}

interface UseComposerSkillSelectionResult {
  updateSelectedSkill: (skillId: string, enabled: boolean) => void
}

export function useComposerSkillSelection({
  availableSkills,
  selectedSkillIds,
  onSelectedSkillIdsChange,
}: UseComposerSkillSelectionArgs): UseComposerSkillSelectionResult {
  const updateSelectedSkill = useCallback(
    (skillId: string, enabled: boolean): void => {
      if (!onSelectedSkillIdsChange) return

      const nextSkillIds = new Set(selectedSkillIds)

      if (enabled) {
        nextSkillIds.add(skillId)
      } else {
        nextSkillIds.delete(skillId)
      }

      const orderedSelectedSkillIds: string[] = []
      for (const skill of availableSkills) {
        if (nextSkillIds.has(skill.id)) {
          orderedSelectedSkillIds.push(skill.id)
        }
      }

      onSelectedSkillIdsChange(orderedSelectedSkillIds)
    },
    [availableSkills, onSelectedSkillIdsChange, selectedSkillIds],
  )

  return { updateSelectedSkill }
}
