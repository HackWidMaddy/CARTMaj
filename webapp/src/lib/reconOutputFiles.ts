/**
 * A Domain-batch run writes one recon file per scan root,
 * `recon_<projectId>__<slug>.json`, beside the canonical `recon_<projectId>.json`
 * (recon/helpers/output_paths.py). Matched by LITERAL prefix, never a glob: the
 * project id reaches this from a request, and a pattern built from it could
 * match another project's files (the Python side, batch_output_files, does the
 * same for the same reason).
 */
import { readdir } from 'fs/promises'
import path from 'path'

export const BATCH_SEPARATOR = '__'

export async function batchGroupFiles(outputDir: string, projectId: string): Promise<string[]> {
  const prefix = `recon_${projectId}${BATCH_SEPARATOR}`
  let names: string[]
  try {
    names = await readdir(outputDir)
  } catch {
    return []
  }
  return names
    .filter(n => n.startsWith(prefix) && n.endsWith('.json'))
    .sort()
    .map(n => path.join(outputDir, n))
}
