/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { i18n } from '@kbn/i18n';

export const anatomyCopy = {
  inUse: i18n.translate('xpack.nightshift.agentAnatomy.inUse', { defaultMessage: 'In use' }),
  reasoningEffort: i18n.translate('xpack.nightshift.agentAnatomy.reasoningEffort', {
    defaultMessage: 'Reasoning effort',
  }),
  title: i18n.translate('xpack.nightshift.agentAnatomy.title', { defaultMessage: 'Agent anatomy' }),
  agents: i18n.translate('xpack.nightshift.agentAnatomy.agents', { defaultMessage: 'Agents' }),
  readOnly: i18n.translate('xpack.nightshift.agentAnatomy.readOnly', {
    defaultMessage: 'Read only',
  }),
  model: i18n.translate('xpack.nightshift.agentAnatomy.model', { defaultMessage: 'Model' }),
  prompt: i18n.translate('xpack.nightshift.agentAnatomy.prompt', {
    defaultMessage: 'System prompt',
  }),
  tools: i18n.translate('xpack.nightshift.agentAnatomy.tools', { defaultMessage: 'Tools' }),
  subAgents: i18n.translate('xpack.nightshift.agentAnatomy.subAgents', {
    defaultMessage: 'Sub-agents',
  }),
  memory: i18n.translate('xpack.nightshift.agentAnatomy.memory', { defaultMessage: 'Memory' }),
  runtime: i18n.translate('xpack.nightshift.agentAnatomy.runtime', { defaultMessage: 'Runtime' }),
  effectiveModel: i18n.translate('xpack.nightshift.agentAnatomy.effectiveModel', {
    defaultMessage: 'Effective model',
  }),
  defaultModel: i18n.translate('xpack.nightshift.agentAnatomy.defaultModel', {
    defaultMessage: 'Default model',
  }),
  connector: i18n.translate('xpack.nightshift.agentAnatomy.connector', {
    defaultMessage: 'Connector',
  }),
  reasoning: i18n.translate('xpack.nightshift.agentAnatomy.reasoning', {
    defaultMessage: 'Reasoning',
  }),
  enabled: i18n.translate('xpack.nightshift.agentAnatomy.enabled', { defaultMessage: 'Enabled' }),
  disabled: i18n.translate('xpack.nightshift.agentAnatomy.disabled', {
    defaultMessage: 'Disabled',
  }),
  effort: i18n.translate('xpack.nightshift.agentAnatomy.effort', { defaultMessage: 'Effort' }),
  skills: i18n.translate('xpack.nightshift.agentAnatomy.skills', { defaultMessage: 'Skills' }),
  noSkills: i18n.translate('xpack.nightshift.agentAnatomy.noSkills', {
    defaultMessage: 'No skills configured',
  }),
  fullPrompt: i18n.translate('xpack.nightshift.agentAnatomy.fullPrompt', {
    defaultMessage: 'Full effective system prompt',
  }),
  searchPrompt: i18n.translate('xpack.nightshift.agentAnatomy.searchPrompt', {
    defaultMessage: 'Find in prompt',
  }),
  promptSearchHint: i18n.translate('xpack.nightshift.agentAnatomy.promptSearchHint', {
    defaultMessage:
      'Matching prompt lines are shown with their original line numbers. Clear the search to read the full prompt.',
  }),
  noPromptMatches: i18n.translate('xpack.nightshift.agentAnatomy.noPromptMatches', {
    defaultMessage: 'No matching prompt lines',
  }),
  noSubAgents: i18n.translate('xpack.nightshift.agentAnatomy.noSubAgents', {
    defaultMessage: 'No sub-agents configured',
  }),
  noSubAgentsBody: i18n.translate('xpack.nightshift.agentAnatomy.noSubAgentsBody', {
    defaultMessage: 'This agent currently performs its work in one model loop.',
  }),
  openAgent: i18n.translate('xpack.nightshift.agentAnatomy.openAgent', {
    defaultMessage: 'Inspect agent',
  }),
  findTool: i18n.translate('xpack.nightshift.agentAnatomy.findTool', {
    defaultMessage: 'Find a tool',
  }),
  noTools: i18n.translate('xpack.nightshift.agentAnatomy.noTools', {
    defaultMessage: 'No tools configured',
  }),
  noToolMatches: i18n.translate('xpack.nightshift.agentAnatomy.noToolMatches', {
    defaultMessage: 'No matching tools',
  }),
  toolInstructions: i18n.translate('xpack.nightshift.agentAnatomy.toolInstructions', {
    defaultMessage: 'Full tool instructions',
  }),
  rawDefinition: i18n.translate('xpack.nightshift.agentAnatomy.rawDefinition', {
    defaultMessage: 'Raw tool definition',
  }),
  parameters: i18n.translate('xpack.nightshift.agentAnatomy.parameters', {
    defaultMessage: 'Parameters',
  }),
  required: i18n.translate('xpack.nightshift.agentAnatomy.required', {
    defaultMessage: 'Required',
  }),
  optional: i18n.translate('xpack.nightshift.agentAnatomy.optional', {
    defaultMessage: 'Optional',
  }),
  operations: i18n.translate('xpack.nightshift.agentAnatomy.operations', {
    defaultMessage: 'Operations',
  }),
  templates: i18n.translate('xpack.nightshift.agentAnatomy.templates', {
    defaultMessage: 'Query templates',
  }),
  values: i18n.translate('xpack.nightshift.agentAnatomy.values', {
    defaultMessage: 'Allowed values',
  }),
  noParameters: i18n.translate('xpack.nightshift.agentAnatomy.noParameters', {
    defaultMessage: 'This tool has no declared parameters.',
  }),
  objectFields: i18n.translate('xpack.nightshift.agentAnatomy.objectFields', {
    defaultMessage: 'Object fields',
  }),
  itemFields: i18n.translate('xpack.nightshift.agentAnatomy.itemFields', {
    defaultMessage: 'Item fields',
  }),
  minimum: i18n.translate('xpack.nightshift.agentAnatomy.minimum', { defaultMessage: 'Minimum' }),
  maximum: i18n.translate('xpack.nightshift.agentAnatomy.maximum', { defaultMessage: 'Maximum' }),
  maxLength: i18n.translate('xpack.nightshift.agentAnatomy.maxLength', {
    defaultMessage: 'Max. characters',
  }),
  minLength: i18n.translate('xpack.nightshift.agentAnatomy.minLength', {
    defaultMessage: 'Min. characters',
  }),
  maxItems: i18n.translate('xpack.nightshift.agentAnatomy.maxItems', {
    defaultMessage: 'Max. items',
  }),
  minItems: i18n.translate('xpack.nightshift.agentAnatomy.minItems', {
    defaultMessage: 'Min. items',
  }),
  multipleOf: i18n.translate('xpack.nightshift.agentAnatomy.multipleOf', {
    defaultMessage: 'Multiple of',
  }),
  pattern: i18n.translate('xpack.nightshift.agentAnatomy.pattern', { defaultMessage: 'Pattern' }),
  format: i18n.translate('xpack.nightshift.agentAnatomy.format', { defaultMessage: 'Format' }),
  defaultValue: i18n.translate('xpack.nightshift.agentAnatomy.defaultValue', {
    defaultMessage: 'Default',
  }),
  showDescription: i18n.translate('xpack.nightshift.agentAnatomy.showDescription', {
    defaultMessage: 'Full description',
  }),
  scope: i18n.translate('xpack.nightshift.agentAnatomy.scope', { defaultMessage: 'Scope' }),
  storage: i18n.translate('xpack.nightshift.agentAnatomy.storage', { defaultMessage: 'Storage' }),
  lifetime: i18n.translate('xpack.nightshift.agentAnatomy.lifetime', {
    defaultMessage: 'Lifetime',
  }),
  noMemory: i18n.translate('xpack.nightshift.agentAnatomy.noMemory', {
    defaultMessage: 'No memory configuration reported',
  }),
  triggers: i18n.translate('xpack.nightshift.agentAnatomy.triggers', {
    defaultMessage: 'Triggers',
  }),
  sourceScope: i18n.translate('xpack.nightshift.agentAnatomy.sourceScope', {
    defaultMessage: 'Sources',
  }),
  space: i18n.translate('xpack.nightshift.agentAnatomy.space', { defaultMessage: 'Kibana space' }),
  lookback: i18n.translate('xpack.nightshift.agentAnatomy.lookback', {
    defaultMessage: 'Evidence window',
  }),
  initialLearning: i18n.translate('xpack.nightshift.agentAnatomy.initialLearning', {
    defaultMessage: 'Initial learning',
  }),
  ongoing: i18n.translate('xpack.nightshift.agentAnatomy.ongoing', {
    defaultMessage: 'Ongoing operation',
  }),
  duration: i18n.translate('xpack.nightshift.agentAnatomy.duration', {
    defaultMessage: 'Duration (minutes)',
  }),
  turns: i18n.translate('xpack.nightshift.agentAnatomy.turns', { defaultMessage: 'Model turns' }),
  tokens: i18n.translate('xpack.nightshift.agentAnatomy.tokens', {
    defaultMessage: 'Cumulative tokens',
  }),
  cost: i18n.translate('xpack.nightshift.agentAnatomy.cost', {
    defaultMessage: 'Estimated cost (USD)',
  }),
  noLimit: i18n.translate('xpack.nightshift.agentAnatomy.noLimit', { defaultMessage: 'No limit' }),
  monitorCapacity: i18n.translate('xpack.nightshift.agentAnatomy.monitorCapacity', {
    defaultMessage: 'Active managed rules per service',
  }),
  hardCost: i18n.translate('xpack.nightshift.agentAnatomy.hardCost', {
    defaultMessage: 'Estimated cost ceiling (USD)',
  }),
  costEstimate: i18n.translate('xpack.nightshift.agentAnatomy.costEstimate', {
    defaultMessage: 'Cost accounting',
  }),
  notReported: i18n.translate('xpack.nightshift.agentAnatomy.notReported', {
    defaultMessage: 'Not reported',
  }),
  loading: i18n.translate('xpack.nightshift.agentAnatomy.loading', {
    defaultMessage: 'Loading agent configuration',
  }),
  error: i18n.translate('xpack.nightshift.agentAnatomy.error', {
    defaultMessage: 'Could not load agent anatomy',
  }),
  retry: i18n.translate('xpack.nightshift.agentAnatomy.retry', { defaultMessage: 'Retry' }),
  refresh: i18n.translate('xpack.nightshift.agentAnatomy.refresh', {
    defaultMessage: 'Refresh configuration',
  }),
  identity: i18n.translate('xpack.nightshift.agentAnatomy.identity', {
    defaultMessage: 'Identity and lifecycle',
  }),
  evidence: i18n.translate('xpack.nightshift.agentAnatomy.evidence', {
    defaultMessage: 'Evidence and scope',
  }),
  assessment: i18n.translate('xpack.nightshift.agentAnatomy.assessment', {
    defaultMessage: 'Assessment',
  }),
  queryStrategy: i18n.translate('xpack.nightshift.agentAnatomy.queryStrategy', {
    defaultMessage: 'Query strategy',
  }),
  sourceWindow: i18n.translate('xpack.nightshift.agentAnatomy.sourceWindow', {
    defaultMessage: 'Source and window',
  }),
  paging: i18n.translate('xpack.nightshift.agentAnatomy.paging', {
    defaultMessage: 'Results and pagination',
  }),
  ruleIdentity: i18n.translate('xpack.nightshift.agentAnatomy.ruleIdentity', {
    defaultMessage: 'Rule identity',
  }),
  ruleDefinition: i18n.translate('xpack.nightshift.agentAnatomy.ruleDefinition', {
    defaultMessage: 'Detection and validation',
  }),
  knowledgeReads: i18n.translate('xpack.nightshift.agentAnatomy.knowledgeReads', {
    defaultMessage: 'Lookup and retrieval',
  }),
  knowledgeWrites: i18n.translate('xpack.nightshift.agentAnatomy.knowledgeWrites', {
    defaultMessage: 'Knowledge and query records',
  }),
  otherParameters: i18n.translate('xpack.nightshift.agentAnatomy.otherParameters', {
    defaultMessage: 'Other parameters',
  }),
  general: i18n.translate('xpack.nightshift.agentAnatomy.general', {
    defaultMessage: 'Tool parameters',
  }),
  scopeAndLimits: i18n.translate('xpack.nightshift.agentAnatomy.scopeAndLimits', {
    defaultMessage: 'Scope and limits',
  }),
};
