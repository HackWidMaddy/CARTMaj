'use client'

import { useCallback, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { MAX_SKILLS_PER_BATCH } from '@/lib/userSkills'
import type { PickedFile } from '@/lib/skillUploadDraft'
import {
  SKILL_FILE_ACCEPT, SkillUploadReviewModal, readPickedFiles, type SkillUploadProject, type UploadResult,
} from './SkillUploadReviewModal'

export type { SkillUploadProject, UploadedSkill, UploadResult } from './SkillUploadReviewModal'

interface Draft { mode: 'single' | 'batch'; files: PickedFile[]; cut: boolean }

/**
 * Upload Skill and Upload Batch: two hidden file pickers and the review dialog.
 *
 * It uses no context hook (toast, alert, model gate): the dialog owns those and is mounted
 * only while open, so a section using this hook still renders where no provider is mounted.
 */
export function useSkillUpload(opts: {
  userId: string | null | undefined
  existingCount: number
  /** Project context; omitted outside a project. */
  project?: SkillUploadProject
  onUploaded?: (result: UploadResult) => void
}): {
  openSingle: () => void
  openBatch: () => void
  /** Hidden file inputs and the dialog; render ONCE, outside any clickable header. */
  dialogs: ReactNode
} {
  const { userId, existingCount, project, onUploaded } = opts
  const single = useRef<HTMLInputElement>(null)
  const batch = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const openSingle = useCallback(() => single.current?.click(), [])
  const openBatch = useCallback(() => batch.current?.click(), [])

  const onPick = useCallback(async (mode: Draft['mode'], e: ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files ?? [])
    // Cleared so the same file can be picked again.
    e.target.value = ''
    if (!list.length) return
    const files = await readPickedFiles(list.slice(0, MAX_SKILLS_PER_BATCH))
    setDraft({ mode, files, cut: list.length > MAX_SKILLS_PER_BATCH })
  }, [])

  const dialogs = (
    <>
      <input
        ref={single}
        type="file"
        accept={SKILL_FILE_ACCEPT}
        style={{ display: 'none' }}
        data-testid="skill-upload-single-input"
        onChange={(e) => void onPick('single', e)}
      />
      <input
        ref={batch}
        type="file"
        accept={SKILL_FILE_ACCEPT}
        multiple
        style={{ display: 'none' }}
        data-testid="skill-upload-batch-input"
        onChange={(e) => void onPick('batch', e)}
      />
      {draft && userId && (
        <SkillUploadReviewModal
          mode={draft.mode}
          userId={userId}
          existingCount={existingCount}
          files={draft.files}
          cut={draft.cut}
          project={project}
          onUploaded={onUploaded}
          onClose={() => setDraft(null)}
        />
      )}
    </>
  )

  return { openSingle, openBatch, dialogs }
}
