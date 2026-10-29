/**
 * Todo List Widget Component
 *
 * Displays agent's todo list with status indicators.
 */

'use client'

import { useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, Circle, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import styles from './TodoListWidget.module.css'
import type { TodoItem } from '@/lib/websocket-types'

interface TodoListWidgetProps {
  items: TodoItem[]
  /** Live KPI chips rendered on the right of the header (Todos bar). */
  headerRight?: ReactNode
}

export function TodoListWidget({ items, headerRight }: TodoListWidgetProps) {
  const [isExpanded, setIsExpanded] = useState(false)

  if ((!items || items.length === 0) && !headerRight) {
    return null
  }

  const hasItems = !!items && items.length > 0

  // Find the current in-progress task
  const currentTask = items.find(item => item.status === 'in_progress')

  const getStatusIcon = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 size={14} className={styles.iconCompleted} />
      case 'in_progress':
        return <Loader2 size={14} className={`${styles.iconInProgress} ${styles.spinner}`} />
      case 'pending':
      default:
        return <Circle size={14} className={styles.iconPending} />
    }
  }

  const getStatusClass = (status: TodoItem['status']) => {
    switch (status) {
      case 'completed':
        return styles.statusCompleted
      case 'in_progress':
        return styles.statusInProgress
      case 'pending':
      default:
        return styles.statusPending
    }
  }

  const getDescription = (item: TodoItem) => {
    // Prioritize activeForm for in_progress items
    if (item.status === 'in_progress' && item.activeForm && item.activeForm.trim()) {
      return item.activeForm
    }

    // Backend uses 'description' field
    if (item.description && item.description.trim()) {
      return item.description
    }

    // Fallback to 'content' for backward compatibility
    if (item.content && item.content.trim()) {
      return item.content
    }

    // Fallback
    return 'No description'
  }

  return (
    <div className={styles.todoWidget}>
      {/* Header: label + expand toggle grouped on the LEFT, live KPIs on the RIGHT */}
      <div className={styles.todoHeader}>
        <div className={styles.todoHeaderLeft}>
          <span className={styles.todoLabel}>Todos</span>
          {hasItems && (
            <button
              className={styles.expandButton}
              onClick={() => setIsExpanded(!isExpanded)}
              title={isExpanded ? 'Collapse list' : 'Expand list'}
            >
              {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
        </div>
        {headerRight && <div className={styles.todoHeaderRight}>{headerRight}</div>}
      </div>

      {/* Current task (visible only when collapsed) */}
      {hasItems && !isExpanded && currentTask && (
        <div className={`${styles.todoItem} ${getStatusClass(currentTask.status)}`}>
          <div className={styles.todoIcon}>{getStatusIcon(currentTask.status)}</div>
          <div className={styles.todoContent}>
            <span className={styles.todoDescription}>{getDescription(currentTask)}</span>
          </div>
        </div>
      )}

      {/* Expanded list (shown when expanded) */}
      {hasItems && isExpanded && (
        <div className={styles.todoListExpanded}>
          {items.map((item, index) => {
            const description = getDescription(item)
            return (
              <div key={index} className={`${styles.todoItem} ${getStatusClass(item.status)}`}>
                <div className={styles.todoIcon}>{getStatusIcon(item.status)}</div>
                <div className={styles.todoContent}>
                  <span className={styles.todoDescription}>{description}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
