/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useId, useRef, useState } from 'react';
import { css } from '@emotion/react';
import { getEbtProps } from '@kbn/ebt-click';
import {
  EuiAccordion,
  EuiBadge,
  EuiButtonEmpty,
  EuiCodeBlock,
  EuiDescriptionList,
  EuiEmptyPrompt,
  EuiFieldSearch,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiTab,
  EuiTabs,
  EuiText,
  EuiTitle,
  useEuiTheme,
} from '@elastic/eui';
import { useQuery } from '@kbn/react-query';
import type { ExplorationAgentAnatomy } from '@kbn/significant-events-plugin/common';
import { KbnDangerCallout } from '@kbn/ui-callout';
import { PROBLEM_AGENT_ANATOMY_QUERY_KEY } from '../../../data/query_keys';
import { useKibana } from '../../../hooks/use_kibana';
import { anatomyCopy as copy } from './anatomy_translations';
import { ToolAnatomy } from './tool_anatomy';

type Section = 'model' | 'prompt' | 'skills' | 'tools' | 'subAgents' | 'memory' | 'runtime';
const findAgent = (
  agent: ExplorationAgentAnatomy,
  id: string
): ExplorationAgentAnatomy | undefined =>
  agent.id === id ? agent : agent.subAgents?.map((child) => findAgent(child, id)).find(Boolean);

const AgentList = ({
  agent,
  selected,
  onSelect,
}: {
  agent: ExplorationAgentAnatomy;
  selected: string;
  onSelect: (id: string) => void;
}): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  return (
    <ul
      css={css`
        list-style: none;
      `}
    >
      <li>
        <button
          {...getEbtProps({ action: 'selectAgent', element: 'agentAnatomy' })}
          type="button"
          aria-label={agent.name}
          aria-pressed={selected === agent.id}
          onClick={() => onSelect(agent.id)}
          css={css`
            display: block;
            width: 100%;
            text-align: left;
            overflow-wrap: anywhere;
            padding: ${euiTheme.size.m};
            border-radius: ${euiTheme.border.radius.medium};
            background: ${selected === agent.id
              ? euiTheme.colors.backgroundBaseSubdued
              : 'transparent'};
            border: 1px solid ${selected === agent.id ? euiTheme.colors.primary : 'transparent'};
            color: ${selected === agent.id ? euiTheme.colors.primaryText : euiTheme.colors.text};
          `}
        >
          <strong>{agent.name}</strong>
          <span
            css={css`
              display: block;
              margin-top: ${euiTheme.size.xs};
              font-size: ${euiTheme.size.m};
              color: ${euiTheme.colors.textSubdued};
            `}
          >
            {agent.model}
          </span>
        </button>
        {Boolean(agent.subAgents?.length) && (
          <div
            css={css`
              padding-left: ${euiTheme.size.m};
              margin-left: ${euiTheme.size.m};
              border-left: ${euiTheme.border.thin};
              margin-top: ${euiTheme.size.s};
            `}
          >
            {agent.subAgents.map((child) => (
              <AgentList key={child.id} agent={child} selected={selected} onSelect={onSelect} />
            ))}
          </div>
        )}
      </li>
    </ul>
  );
};

const ModelSection = ({ agent }: { agent: ExplorationAgentAnatomy }): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  return (
    <>
      <div
        css={css`
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
          gap: ${euiTheme.size.m};
        `}
      >
        {[
          ...(agent.connectorId !== agent.defaultModel?.connectorId
            ? [{ title: copy.effectiveModel, model: agent.model, connectorId: agent.connectorId }]
            : []),
          {
            title: copy.defaultModel,
            model: agent.defaultModel?.model ?? copy.notReported,
            connectorId: agent.defaultModel?.connectorId,
          },
        ].map((model) => (
          <EuiPanel key={model.title} hasBorder hasShadow={false} paddingSize="l">
            <EuiText size="xs" color="subdued">
              <strong>{model.title}</strong>
              {model.connectorId === agent.connectorId && (
                <>
                  {' '}
                  <EuiBadge color="success">{copy.inUse}</EuiBadge>
                </>
              )}
            </EuiText>
            <EuiSpacer size="s" />
            <EuiTitle size="xs">
              <h4>{model.model}</h4>
            </EuiTitle>
            {model.connectorId && (
              <>
                <EuiSpacer size="m" />
                <EuiText size="xs" color="subdued">
                  <p
                    css={css`
                      overflow-wrap: anywhere;
                    `}
                  >
                    {model.connectorId}
                  </p>
                </EuiText>
              </>
            )}
          </EuiPanel>
        ))}
      </div>
      <EuiSpacer size="l" />
      {agent.thinking && (
        <EuiDescriptionList
          type="column"
          compressed
          listItems={[
            {
              title: copy.reasoning,
              description: agent.thinking.enabled ? copy.enabled : copy.disabled,
            },
            { title: copy.reasoningEffort, description: agent.thinking.effort },
          ]}
        />
      )}
    </>
  );
};

const SkillsSection = ({ agent }: { agent: ExplorationAgentAnatomy }): React.ReactElement => (
  <>
    {agent.skills?.length ? (
      agent.skills.map((skill) => (
        <EuiAccordion
          key={skill.name}
          id={`${agent.id}-skill-${skill.name}`}
          buttonContent={skill.name}
          paddingSize="s"
        >
          <EuiText size="s">
            <p>{skill.description}</p>
          </EuiText>
          <EuiSpacer size="s" />
          <EuiCodeBlock language="markdown" fontSize="s" isCopyable whiteSpace="pre-wrap">
            {skill.content}
          </EuiCodeBlock>
        </EuiAccordion>
      ))
    ) : (
      <EuiText size="s" color="subdued">
        <p>{copy.noSkills}</p>
      </EuiText>
    )}
  </>
);

const PromptSection = ({ prompt }: { prompt: string }): React.ReactElement => {
  const [query, setQuery] = useState('');
  const lines = prompt.split('\n');
  const matches = lines.flatMap((line, index) =>
    line.toLowerCase().includes(query.toLowerCase()) ? [`${index + 1}  ${line}`] : []
  );
  return (
    <>
      <EuiFieldSearch
        data-test-subj="nightshiftAgentAnatomyPromptSearch"
        aria-label={copy.searchPrompt}
        placeholder={copy.searchPrompt}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        fullWidth
        isClearable
      />
      <EuiSpacer size="m" />
      {query && (
        <>
          <EuiText size="xs" color="subdued">
            <p>{copy.promptSearchHint}</p>
          </EuiText>
          <EuiSpacer size="s" />
        </>
      )}
      {query && !matches.length ? (
        <EuiText color="subdued">
          <p>{copy.noPromptMatches}</p>
        </EuiText>
      ) : (
        <EuiCodeBlock language="text" whiteSpace="pre-wrap" fontSize="s" isCopyable={!query}>
          {query ? matches.join('\n') : prompt}
        </EuiCodeBlock>
      )}
    </>
  );
};

const MemorySection = ({ agent }: { agent: ExplorationAgentAnatomy }): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  return (
    <div
      css={css`
        display: grid;
        gap: ${euiTheme.size.m};
      `}
    >
      {agent.memory?.length ? (
        agent.memory.map((memory) => (
          <EuiPanel key={memory.name} hasBorder hasShadow={false}>
            <EuiTitle size="xxs">
              <h4>{memory.name}</h4>
            </EuiTitle>
            <EuiSpacer size="m" />
            <EuiDescriptionList
              compressed
              listItems={[
                { title: copy.scope, description: memory.scope },
                { title: copy.storage, description: memory.storage },
                { title: copy.lifetime, description: memory.lifetime },
              ]}
            />
          </EuiPanel>
        ))
      ) : agent.persistence?.length ? (
        <EuiText size="s">
          <ul>
            {agent.persistence.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </EuiText>
      ) : (
        <EuiText color="subdued">
          <p>{copy.noMemory}</p>
        </EuiText>
      )}
    </div>
  );
};

const RuntimeSection = ({ agent }: { agent: ExplorationAgentAnatomy }): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  const show = (value: number | null): string =>
    value === null ? copy.noLimit : value.toLocaleString();
  return (
    <>
      {agent.scope && (
        <>
          <EuiTitle size="xxs">
            <h4>{copy.scope}</h4>
          </EuiTitle>
          <EuiSpacer size="m" />
          <EuiDescriptionList
            compressed
            listItems={[
              { title: copy.space, description: agent.scope.spaceId },
              { title: copy.sourceScope, description: agent.scope.sources },
              { title: copy.lookback, description: agent.scope.lookback },
            ]}
          />
          <EuiSpacer size="l" />
        </>
      )}
      {Boolean(agent.triggers?.length) && (
        <>
          <EuiTitle size="xxs">
            <h4>{copy.triggers}</h4>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiText size="s">
            <ul>
              {agent.triggers?.map((trigger) => (
                <li key={trigger}>{trigger}</li>
              ))}
            </ul>
          </EuiText>
          <EuiSpacer size="l" />
        </>
      )}
      {agent.limits && (
        <>
          <div
            css={css`
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
              gap: ${euiTheme.size.m};
            `}
          >
            {[
              { title: copy.ongoing, limits: agent.limits },
              { title: copy.initialLearning, limits: agent.limits.initialLearning },
            ].map(({ title, limits }) => (
              <EuiPanel key={title} hasBorder hasShadow={false}>
                <EuiTitle size="xxs">
                  <h4>{title}</h4>
                </EuiTitle>
                <EuiSpacer size="m" />
                <EuiDescriptionList
                  type="column"
                  compressed
                  listItems={[
                    { title: copy.duration, description: show(limits.maxDurationMinutes) },
                    { title: copy.turns, description: show(limits.maxTurns) },
                    { title: copy.tokens, description: show(limits.maxCumulativeTokens) },
                    { title: copy.cost, description: show(limits.maxEstimatedCostUsd) },
                  ]}
                />
              </EuiPanel>
            ))}
          </div>
          <EuiSpacer size="l" />
          <EuiDescriptionList
            compressed
            listItems={[
              {
                title: copy.monitorCapacity,
                description: show(agent.limits.maxActiveManagedRulesPerService),
              },
              { title: copy.hardCost, description: show(agent.limits.hardEstimatedCostCeilingUsd) },
            ]}
          />
          <EuiSpacer size="l" />
        </>
      )}
      {agent.costEstimate && (
        <>
          <EuiTitle size="xxs">
            <h4>{copy.costEstimate}</h4>
          </EuiTitle>
          <EuiSpacer size="s" />
          <EuiText size="s" color="subdued">
            <p>{agent.costEstimate}</p>
          </EuiText>
        </>
      )}
    </>
  );
};

const AgentDetails = ({
  agent,
  onSelect,
}: {
  agent: ExplorationAgentAnatomy;
  onSelect: (id: string) => void;
}): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  const [section, setSection] = useState<Section>('model');
  const panelId = useId();
  const scrollPanel = useRef<HTMLDivElement>(null);
  const resetScroll = () => {
    if (scrollPanel.current) scrollPanel.current.scrollTop = 0;
  };
  const tabs: Array<{ id: Section; label: string; count?: number }> = [
    { id: 'model', label: copy.model },
    { id: 'prompt', label: copy.prompt },
    { id: 'skills', label: copy.skills, count: agent.skills?.length ?? 0 },
    { id: 'tools', label: copy.tools, count: agent.tools.length },
    { id: 'subAgents', label: copy.subAgents, count: agent.subAgents?.length ?? 0 },
    { id: 'memory', label: copy.memory },
    { id: 'runtime', label: copy.runtime },
  ];
  return (
    <section
      css={css`
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
      `}
    >
      <div
        css={css`
          padding: 0 ${euiTheme.size.l} ${euiTheme.size.m};
          @media (max-width: 767px) {
            padding-left: ${euiTheme.size.s};
            padding-right: ${euiTheme.size.s};
          }
        `}
      >
        <EuiTitle size="s">
          <h3>{agent.name}</h3>
        </EuiTitle>
        <EuiSpacer size="s" />
        <EuiText size="s" color="subdued">
          <p>{agent.description}</p>
        </EuiText>
        <EuiSpacer size="m" />
        <EuiTabs
          size="s"
          css={css`
            flex-wrap: wrap;
          `}
        >
          {tabs.map((tab) => (
            <EuiTab
              {...getEbtProps({ action: 'selectSection', element: 'agentAnatomy' })}
              key={tab.id}
              id={`${panelId}-${tab.id}`}
              aria-controls={`${panelId}-content`}
              isSelected={section === tab.id}
              onClick={() => {
                setSection(tab.id);
                resetScroll();
              }}
            >
              <span
                css={css`
                  display: inline-flex;
                  align-items: center;
                  gap: ${euiTheme.size.xs};
                `}
              >
                {tab.label}
                {tab.count !== undefined && <EuiBadge color="hollow">{tab.count}</EuiBadge>}
              </span>
            </EuiTab>
          ))}
        </EuiTabs>
      </div>
      <div
        ref={scrollPanel}
        id={`${panelId}-content`}
        role="tabpanel"
        aria-labelledby={`${panelId}-${section}`}
        tabIndex={0}
        css={css`
          flex: 1;
          min-height: 0;
          min-width: 0;
          overflow: auto;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
          padding: ${euiTheme.size.s} ${euiTheme.size.l} ${euiTheme.size.l};
          @media (max-width: 767px) {
            padding-left: ${euiTheme.size.s};
            padding-right: ${euiTheme.size.s};
          }
        `}
      >
        {section === 'model' && <ModelSection agent={agent} />}
        {section === 'prompt' && <PromptSection prompt={agent.systemPrompt} />}
        {section === 'skills' && <SkillsSection agent={agent} />}
        {section === 'tools' && <ToolAnatomy tools={agent.tools} onNavigate={resetScroll} />}
        {section === 'subAgents' &&
          (agent.subAgents?.length ? (
            <div
              css={css`
                display: grid;
                gap: ${euiTheme.size.m};
              `}
            >
              {agent.subAgents.map((child) => (
                <EuiPanel key={child.id} hasBorder hasShadow={false}>
                  <EuiTitle size="xs">
                    <h4>{child.name}</h4>
                  </EuiTitle>
                  <EuiSpacer size="s" />
                  <EuiText size="s">
                    <p>{child.description}</p>
                  </EuiText>
                  <EuiSpacer size="s" />
                  <EuiText color="subdued" size="xs">
                    <p>{child.model}</p>
                  </EuiText>
                  <EuiButtonEmpty
                    {...getEbtProps({ action: 'inspectSubAgent', element: 'agentAnatomy' })}
                    data-test-subj="nightshiftAgentAnatomyInspectSubAgent"
                    size="s"
                    onClick={() => onSelect(child.id)}
                  >
                    {copy.openAgent}
                  </EuiButtonEmpty>
                </EuiPanel>
              ))}
            </div>
          ) : (
            <EuiEmptyPrompt
              iconType="users"
              title={<h4>{copy.noSubAgents}</h4>}
              titleSize="s"
              body={<p>{copy.noSubAgentsBody}</p>}
            />
          ))}
        {section === 'memory' && <MemorySection agent={agent} />}
        {section === 'runtime' && <RuntimeSection agent={agent} />}
      </div>
    </section>
  );
};

export const AgentAnatomyContent = ({
  agent,
}: {
  agent: ExplorationAgentAnatomy;
}): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  const [selectedId, setSelectedId] = useState(agent.id);
  const selected = findAgent(agent, selectedId) ?? agent;
  return (
    <div
      css={css`
        display: grid;
        grid-template-columns: 220px minmax(0, 1fr);
        height: calc(100dvh - 150px);
        min-height: 260px;
        min-width: 0;
        @media (max-width: 767px) {
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(0, 1fr);
        }
      `}
    >
      <nav
        aria-label={copy.agents}
        css={css`
          min-height: 0;
          overflow: auto;
          border-right: ${euiTheme.border.thin};
          padding-right: ${euiTheme.size.m};
          @media (max-width: 767px) {
            max-height: 130px;
            border-right: 0;
            border-bottom: ${euiTheme.border.thin};
            margin-bottom: ${euiTheme.size.m};
            padding-bottom: ${euiTheme.size.s};
          }
        `}
      >
        <AgentList agent={agent} selected={selected.id} onSelect={setSelectedId} />
      </nav>
      <AgentDetails key={selected.id} agent={selected} onSelect={setSelectedId} />
    </div>
  );
};

export function AgentAnatomy({ onClose }: { onClose: () => void }): React.ReactElement {
  const { http } = useKibana().services;
  const titleId = useId();
  const anatomy = useQuery({
    queryKey: PROBLEM_AGENT_ANATOMY_QUERY_KEY,
    queryFn: ({ signal }) =>
      http.get<ExplorationAgentAnatomy>('/internal/significant_events/problem_agent/anatomy', {
        signal,
      }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <EuiFlyout onClose={onClose} size="min(1280px, 96vw)" aria-labelledby={titleId}>
      <EuiFlyoutHeader hasBorder>
        <div
          css={css`
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding-right: 24px;
          `}
        >
          <EuiTitle>
            <h2 id={titleId}>{copy.title}</h2>
          </EuiTitle>
          <div>
            <EuiBadge color="hollow">{copy.readOnly}</EuiBadge>
            <EuiButtonEmpty
              {...getEbtProps({ action: 'refresh', element: 'agentAnatomy' })}
              data-test-subj="nightshiftAgentAnatomyRefresh"
              size="s"
              iconType="refresh"
              isDisabled={anatomy.isFetching}
              onClick={() => anatomy.refetch()}
            >
              {copy.refresh}
            </EuiButtonEmpty>
          </div>
        </div>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        {anatomy.error ? (
          <KbnDangerCallout
            title={copy.error}
            text={anatomy.error instanceof Error ? anatomy.error.message : String(anatomy.error)}
            actionProps={{
              primary: {
                children: copy.retry,
                onClick: () => anatomy.refetch(),
                'data-test-subj': 'nightshiftAgentAnatomyRetry',
                ...getEbtProps({ action: 'retry', element: 'agentAnatomy' }),
              },
            }}
          />
        ) : anatomy.data ? (
          <AgentAnatomyContent agent={anatomy.data} />
        ) : (
          <EuiLoadingSpinner aria-label={copy.loading} />
        )}
      </EuiFlyoutBody>
    </EuiFlyout>
  );
}
