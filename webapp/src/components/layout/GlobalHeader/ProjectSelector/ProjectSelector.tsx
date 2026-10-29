'use client'

import { useState, useRef, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import { ChevronDown, FolderOpen, Plus, Settings } from 'lucide-react'
import { useProject } from '@/providers/ProjectProvider'
import { useProjects, type ProjectListItem } from '@/hooks/useProjects'
import { projectTargetLabel, toProjectSummary } from '@/lib/projectSummary'
import { useGuardedRouter, useNavigationGuard } from '@/context/NavigationGuardContext'
import styles from './ProjectSelector.module.css'

export function ProjectSelector() {
  const router = useGuardedRouter()
  const guard = useNavigationGuard()
  const pathname = usePathname()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { currentProject, setCurrentProject, userId } = useProject()
  const { data: projects } = useProjects(userId || undefined)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelectProject = async (project: ProjectListItem) => {
    // Switching the active project abandons whatever dirty form is open, so
    // confirm before mutating context (not just before navigating).
    if (guard?.hasGuards() && !(await guard.confirmAllGuards())) return
    setCurrentProject(toProjectSummary(project))
    setIsOpen(false)

    // If on a project settings page, navigate to the new project's settings.
    // The guard already ran above, so push directly (avoid a second prompt).
    if (pathname.match(/\/projects\/[^/]+\/settings/)) {
      router.pushUnguarded(`/projects/${project.id}/settings`)
    }
  }

  const handleSettings = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (currentProject) {
      router.push(`/projects/${currentProject.id}/settings`)
      setIsOpen(false)
    }
  }

  const handleNewProject = () => {
    router.push('/projects/new')
    setIsOpen(false)
  }

  const handleViewAll = () => {
    router.push('/projects')
    setIsOpen(false)
  }

  return (
    <div className={styles.container} ref={dropdownRef}>
      <div className={styles.triggerGroup}>
        <button
          className={styles.trigger}
          onClick={() => setIsOpen(!isOpen)}
          title="Select Project"
        >
          <FolderOpen size={14} />
          <span className={styles.projectName}>
            {currentProject?.name || 'No Project'}
          </span>
          <ChevronDown size={12} className={isOpen ? styles.iconOpen : ''} />
        </button>
        {currentProject && (
          <button
            className={styles.settingsIconButton}
            onClick={handleSettings}
            title="Project Settings"
          >
            <Settings size={13} />
          </button>
        )}
      </div>

      {isOpen && (
        <div className={styles.dropdown}>
          <div className={styles.header}>
            <span className={styles.headerTitle}>Projects</span>
            {currentProject && (
              <button
                className={styles.settingsButton}
                onClick={handleSettings}
                title="Project Settings"
              >
                <Settings size={12} />
              </button>
            )}
          </div>

          <div className={styles.list}>
            {!userId ? (
              <div className={styles.empty}>
                Select a user to view projects
              </div>
            ) : projects && projects.length > 0 ? (
              projects.map((project) => (
                <button
                  key={project.id}
                  className={`${styles.item} ${currentProject?.id === project.id ? styles.itemActive : ''}`}
                  onClick={() => handleSelectProject(project)}
                >
                  <div className={styles.itemContent}>
                    <span className={styles.itemName}>{project.name}</span>
                    <span className={styles.itemDomain}>{projectTargetLabel(project)}</span>
                  </div>
                </button>
              ))
            ) : (
              <div className={styles.empty}>
                No projects yet
              </div>
            )}
          </div>

          <div className={styles.footer}>
            <button className={styles.footerButton} onClick={handleNewProject} disabled={!userId}>
              <Plus size={12} />
              New Project
            </button>
            <button className={styles.footerButton} onClick={handleViewAll}>
              Manage Projects
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default ProjectSelector
