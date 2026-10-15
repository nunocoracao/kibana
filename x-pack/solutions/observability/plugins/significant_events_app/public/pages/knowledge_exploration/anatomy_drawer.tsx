/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useState } from 'react';
import {
  EuiAccordion,
  EuiBadge,
  EuiCodeBlock,
  EuiDescriptionList,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiLoadingSpinner,
  EuiSpacer,
  EuiTabs,
  EuiTab,
  EuiText,
  EuiTitle,
  useGeneratedHtmlId,
} from '@elastic/eui';
import { KbnDangerCallout } from '@kbn/ui-callout';
import { i18n } from '@kbn/i18n';
import { useQuery } from '@kbn/react-query';
import { useKibana } from '../../hooks/use_kibana';

const labels = {
  title: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.title', {
    defaultMessage: 'Agent anatomy',
  }),
  prompt: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.prompt', {
    defaultMessage: 'System prompt',
  }),
  tools: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.tools', {
    defaultMessage: 'Tools',
  }),
  loop: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.loop', {
    defaultMessage: 'Model & loop',
  }),
  description: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.description', {
    defaultMessage:
      'The actual configuration used by new runs. Inspect the prompt, tool contracts, model and guardrails.',
  }),
  error: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.error', {
    defaultMessage: 'Could not load agent anatomy',
  }),
  model: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.model', {
    defaultMessage: 'Model',
  }),
  connector: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.connector', {
    defaultMessage: 'Inference connector',
  }),
  thinking: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.thinking', {
    defaultMessage: 'Thinking requested',
  }),
  skills: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.skills', {
    defaultMessage: 'Skills',
  }),
  scope: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.scope', {
    defaultMessage: 'Scope',
  }),
  triggers: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.triggers', {
    defaultMessage: 'Triggers',
  }),
  limits: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.limits', {
    defaultMessage: 'Run limits',
  }),
  memory: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.memory', {
    defaultMessage: 'Stored state',
  }),
  costs: i18n.translate('xpack.significantEventsApp.knowledgeExplorer.anatomy.costs', {
    defaultMessage: 'Cost calculation',
  }),
};

export function AnatomyDrawer({
  onClose,
  agent = 'knowledge',
}: {
  onClose: () => void;
  agent?: 'knowledge' | 'monitoring' | 'events';
}) {
  const monitoring = agent === 'monitoring';
  const events = agent === 'events';
  const client = useKibana().dependencies.start.significantEvents.significantEventsRepositoryClient;
  const titleId = useGeneratedHtmlId({ prefix: 'knowledgeExplorerAnatomy' });
  const [tab, setTab] = useState('loop');
  const query = useQuery({
    queryKey: ['agent-explorer-anatomy', agent],
    queryFn: ({ signal }) =>
      client.fetch(
        events
          ? 'GET /internal/significant_events/event_discovery/anatomy'
          : monitoring
          ? 'GET /internal/significant_events/monitoring_setup/anatomy'
          : 'GET /internal/significant_events/knowledge_exploration/anatomy',
        {
          signal: signal ?? null,
        }
      ),
    refetchOnMount: 'always',
  });
  const anatomy = query.data;
  const tabs = [
    { id: 'loop', label: labels.loop },
    { id: 'prompt', label: labels.prompt },
    { id: 'tools', label: labels.tools },
  ];
  return (
    <EuiFlyout onClose={onClose} size="m" aria-labelledby={titleId}>
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="s">
          <h2 id={titleId}>{labels.title}</h2>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiText size="s" color="subdued">
          {labels.description}
        </EuiText>
        <EuiSpacer size="m" />
        <EuiTabs>
          {tabs.map((item) => (
            <EuiTab key={item.id} isSelected={tab === item.id} onClick={() => setTab(item.id)}>
              {item.label}
            </EuiTab>
          ))}
        </EuiTabs>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        {query.isLoading && <EuiLoadingSpinner size="l" />}
        {Boolean(query.error) && (
          <KbnDangerCallout title={labels.error}>
            <p>{query.error instanceof Error ? query.error.message : String(query.error)}</p>
          </KbnDangerCallout>
        )}
        {anatomy && tab === 'prompt' && (
          <EuiCodeBlock language="markdown" fontSize="s" paddingSize="m" isCopyable>
            {anatomy.systemPrompt}
          </EuiCodeBlock>
        )}
        {anatomy &&
          tab === 'tools' &&
          anatomy.tools.map((tool) => (
            <React.Fragment key={tool.name}>
              <EuiAccordion
                id={`${titleId}-${tool.name}`}
                buttonContent={<strong>{tool.name}</strong>}
                initialIsOpen
                paddingSize="m"
              >
                <EuiText size="s">
                  <p>{tool.description}</p>
                </EuiText>
                <EuiSpacer size="s" />
                <EuiCodeBlock
                  language="json"
                  fontSize="s"
                  paddingSize="s"
                  overflowHeight={300}
                  isCopyable
                >
                  {JSON.stringify(tool.schema, null, 2)}
                </EuiCodeBlock>
              </EuiAccordion>
              <EuiSpacer size="m" />
            </React.Fragment>
          ))}
        {anatomy && tab === 'loop' && (
          <>
            <EuiFlexGroup gutterSize="s" wrap>
              <EuiFlexItem grow={false}>
                <EuiBadge color="primary">{anatomy.model}</EuiBadge>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiBadge color="hollow">{anatomy.tools.length} tools</EuiBadge>
              </EuiFlexItem>
              <EuiFlexItem grow={false}>
                <EuiBadge color="hollow">No skills</EuiBadge>
              </EuiFlexItem>
            </EuiFlexGroup>
            <EuiSpacer size="l" />
            <EuiDescriptionList
              listItems={[
                { title: labels.model, description: anatomy.model },
                {
                  title: labels.connector,
                  description: (
                    <EuiCodeBlock fontSize="s" paddingSize="s" isCopyable>
                      {anatomy.connectorId}
                    </EuiCodeBlock>
                  ),
                },
                {
                  title: labels.thinking,
                  description: `Enabled · ${anatomy.thinking.effort} effort. Provider thinking-token reporting may be unavailable.`,
                },
                { title: labels.skills, description: 'None. The loop only uses its five tools.' },
                {
                  title: labels.scope,
                  description: `${anatomy.scope.sources} · ${anatomy.scope.lookback} lookback · ${anatomy.scope.spaceId}`,
                },
                { title: labels.triggers, description: anatomy.triggers.join(' · ') },
                {
                  title: labels.limits,
                  description: (
                    <EuiText size="s">
                      <p>
                        {i18n.translate(
                          'xpack.significantEventsApp.knowledgeExplorer.initialLimits',
                          {
                            defaultMessage:
                              'Initial learning: up to {minutes} minutes, {turns} turns and ${cost} estimated chat cost.',
                            values: {
                              minutes: anatomy.limits.initialLearning.maxDurationMinutes,
                              turns: anatomy.limits.initialLearning.maxTurns,
                              cost: anatomy.limits.initialLearning.maxEstimatedCostUsd,
                            },
                          }
                        )}
                      </p>
                      <p>
                        {i18n.translate(
                          'xpack.significantEventsApp.knowledgeExplorer.incrementalLimits',
                          {
                            defaultMessage:
                              'Incremental: up to {minutes} minutes, {turns} turns and ${cost} estimated chat cost. These are ceilings, not spending targets.',
                            values: {
                              minutes: anatomy.limits.incremental.maxDurationMinutes,
                              turns: anatomy.limits.incremental.maxTurns,
                              cost: anatomy.limits.incremental.maxEstimatedCostUsd,
                            },
                          }
                        )}
                      </p>
                    </EuiText>
                  ),
                },
                { title: labels.memory, description: anatomy.persistence.join(' · ') },
                { title: labels.costs, description: anatomy.costEstimate },
              ]}
            />
          </>
        )}
      </EuiFlyoutBody>
    </EuiFlyout>
  );
}
