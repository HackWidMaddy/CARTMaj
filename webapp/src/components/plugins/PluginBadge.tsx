import { Puzzle } from 'lucide-react'
import styles from './plugins.module.css'

/** Marks what a CART plugin contributes, so it is never mistaken for core UI (or for MCP Tool Plugins). */
export function PluginBadge({ label = 'Plugin' }: { label?: string }) {
  return (
    <span className={styles.badge} title="CART plugin">
      <Puzzle size={10} aria-hidden />
      {label}
    </span>
  )
}
