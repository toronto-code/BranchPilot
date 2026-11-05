import { z } from 'zod';
import type { Config } from './types.js';

export const modelCatalogSchema = z.array(z.object({
  providerId: z.string().min(1), modelId: z.string().min(1), displayLabel: z.string().optional(),
  isDefault: z.boolean(), isActive: z.boolean(),
  variants: z.union([z.array(z.string()), z.literal('unknown')]).optional(),
}).passthrough());
export type CatalogModel = z.infer<typeof modelCatalogSchema>[number];
export interface ConfirmedAgentSettings {
  providerId: string; modelId: string; displayLabel?: string; effort?: string; reason: string;
}

/** Preferences are exact catalog selectors, never guessed provider IDs or fuzzy brand rankings. */
export function resolveMuseSettings(agent: Config['agent'], rows: CatalogModel[]): {
  model?: CatalogModel; setModel: boolean; effort?: string; reason: string;
} {
  let model: CatalogModel | undefined;
  let reason = 'Host default retained';
  if (agent.model.kind === 'host-default') model = rows.find(row => row.isActive) ?? rows.find(row => row.isDefault);
  else {
    const choices = agent.model.kind === 'explicit' ? [agent.model] : agent.model.choices;
    for (const [index, choice] of choices.entries()) {
      const matches = rows.filter(row => (!choice.providerId || row.providerId === choice.providerId) &&
        ('modelId' in choice ? row.modelId === choice.modelId : row.displayLabel === choice.displayLabel));
      if (matches.length > 1) throw Error('Model preference is ambiguous; specify the exact providerId and modelId');
      if (matches.length) {
        model = matches[0];
        reason = agent.model.kind === 'explicit' ? 'Explicit model selected' : `Preference ${index + 1}/${choices.length} selected; ${index} earlier choices absent from the catalog`;
        break;
      }
    }
    if (!model) throw Error(agent.model.kind === 'explicit' ? 'Requested model is absent from host catalog' : 'No preferred model is advertised; refusing to fall back to the host default');
  }
  let effort: string | undefined;
  if (agent.effort.kind === 'explicit') effort = agent.effort.value;
  if (agent.effort.kind === 'highest') {
    // MSP's closed effort vocabulary has an explicit strength order. Unknown
    // future tiers are not assumed stronger, and catalog order is not a rank.
    const order = ['high', 'xhigh', 'max'];
    const eligible = order.slice(order.indexOf(agent.effort.minimum));
    effort = eligible.reverse().find(tier => Array.isArray(model?.variants) && model.variants.includes(tier));
    if (!effort) throw Error(`Selected model does not advertise a known effort at least ${agent.effort.minimum}`);
    reason += `; highest advertised known effort: ${effort}`;
  }
  if (effort !== undefined && (!Array.isArray(model?.variants) || !model.variants.includes(effort))) throw Error('Requested effort is not advertised for the selected model');
  return { model, setModel: agent.model.kind !== 'host-default', effort, reason };
}
