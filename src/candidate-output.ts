import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { hypothesesSchema } from './config.js';
import type { BackendResult } from './backend.js';
import { contained, readRegularText } from './workspaces.js';

export const candidateOutputSchema = z.object({ schemaVersion: z.literal(1), proposal: z.string().max(200_000).optional(), hypotheses: hypothesesSchema }).strict();
/** Candidate claims are metadata, never evaluator evidence. Malformed output cannot be promoted. */
export function candidateOutput(workspace: string, result: BackendResult, idea: boolean, muse: boolean): Pick<BackendResult, 'proposal' | 'hypotheses'> {
  let { proposal, hypotheses } = result;
  const metadataPath = contained(workspace, 'branchpilot-result.json');
  if (existsSync(metadataPath)) {
    const metadata = candidateOutputSchema.parse(JSON.parse(readRegularText(metadataPath, 256 * 1024)));
    proposal = metadata.proposal ?? proposal; hypotheses = metadata.hypotheses;
  }
  if (idea) {
    const proposalPath = contained(workspace, 'proposal.md');
    if (muse && existsSync(proposalPath)) {
      proposal = readRegularText(proposalPath, 256 * 1024);
    } else writeFileSync(join(workspace, 'proposal.md'), proposal);
  }
  return { proposal, hypotheses };
}
