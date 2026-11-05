import { z } from 'zod';
import type { BackendAnswer } from './backend.js';

export const backendAnswerSchema = z.object({
  userInputId: z.string().min(1),
  answers: z.array(z.object({
    questionId: z.string().min(1), freeText: z.string().min(1).max(500).optional(),
    selectedLabel: z.string().min(1).optional(), selectedLabels: z.array(z.string().min(1)).optional(), note: z.string().max(500).optional(),
  }).strict().superRefine((answer, ctx) => {
    if ([answer.freeText, answer.selectedLabel, answer.selectedLabels].filter(value => value !== undefined).length !== 1) ctx.addIssue({ code: 'custom', message: 'Provide exactly one answer form' });
  })).min(1).max(3),
}).strict();

const questionSchema = z.object({
  sessionId: z.string(), turnId: z.string(), userInputId: z.string(),
  questions: z.array(z.object({ id: z.string(), options: z.array(z.object({ label: z.string() }).passthrough()).optional(), selection: z.object({ mode: z.string(), minSelections: z.number().optional(), maxSelections: z.number().optional() }).passthrough().optional() }).passthrough()),
}).passthrough();
export function validateBackendAnswer(input: unknown, question: unknown, sessionId: string, turnId: string): BackendAnswer {
  const answer = backendAnswerSchema.parse(input); const prompt = questionSchema.parse(question);
  if (prompt.sessionId !== sessionId || prompt.turnId !== turnId || prompt.userInputId !== answer.userInputId) throw Error('Answer does not match the persisted session, turn and input IDs');
  if (answer.answers.length !== prompt.questions.length || new Set(answer.answers.map(a => a.questionId)).size !== answer.answers.length) throw Error('Answer every question exactly once');
  for (const choice of answer.answers) {
    const q = prompt.questions.find(q => q.id === choice.questionId);
    if (!q) throw Error(`Unknown question: ${choice.questionId}`);
    const labels = choice.selectedLabels ?? (choice.selectedLabel ? [choice.selectedLabel] : []);
    if (new Set(labels).size !== labels.length || labels.some(label => !q.options?.some(o => o.label === label))) throw Error('Answer selected an unoffered or duplicate option');
    if (choice.selectedLabels && q.selection?.mode !== 'multiple') throw Error('Question does not accept multiple selections');
    if (choice.selectedLabel && q.selection?.mode === 'multiple') throw Error('Question requires multiple-selection answer format');
    if (choice.selectedLabels && (labels.length < (q.selection?.minSelections ?? 1) || labels.length > (q.selection?.maxSelections ?? q.options?.length ?? Infinity))) throw Error('Answer violates selection bounds');
  }
  return answer;
}
