/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useState } from 'react';
import { css } from '@emotion/react';
import { getEbtProps } from '@kbn/ebt-click';
import {
  EuiAccordion,
  EuiBadge,
  EuiCode,
  EuiCodeBlock,
  EuiFieldSearch,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTitle,
  useEuiTheme,
} from '@elastic/eui';
import type { ToolDefinition, ToolSchemaType } from '@kbn/inference-common';
import { anatomyCopy as copy } from './anatomy_translations';

type AnatomyTool = ToolDefinition & { name: string };
type Parameter = ToolSchemaType & {
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  multipleOf?: number;
  pattern?: string;
  format?: string;
  default?: string | number | boolean;
};
interface ParameterGroup {
  title: string;
  names: string[];
}

const groupsFor = (name: string): ParameterGroup[] => {
  const paging = {
    title: copy.paging,
    names: ['offset', 'limit', 'maxRows', 'queryOffset', 'queryLimit'],
  };
  switch (name) {
    case 'load_skill':
      return [{ title: copy.skills, names: ['name'] }];
    case 'source_esql':
      return [
        {
          title: copy.sourceWindow,
          names: [
            'sourceIds',
            'serviceNames',
            'serviceNamespaces',
            'lookbackMinutes',
            'endOffsetMinutes',
            'sampleProbability',
          ],
        },
        {
          title: copy.queryStrategy,
          names: ['template', 'pipeline', 'fieldSearch', 'sampleKind', 'pattern', 'query'],
        },
        paging,
      ];
    case 'rule_change_points':
      return [
        {
          title: copy.ruleIdentity,
          names: ['signalRef', 'ruleId', 'sourceId', 'groupFiltersJson'],
        },
        { title: copy.sourceWindow, names: ['lookbackMinutes', 'includeSeries'] },
      ];
    case 'monitoring_rules':
      return [
        {
          title: copy.ruleIdentity,
          names: ['action', 'sourceId', 'ruleId', 'slug', 'title', 'description', 'reason'],
        },
        {
          title: copy.ruleDefinition,
          names: [
            'kind',
            'pipeline',
            'featureIds',
            'evidenceRefs',
            'groupBy',
            'lookbackMinutes',
            'intervalMinutes',
            'windowSize',
            'baselineRef',
          ],
        },
      ];
    case 'knowledge_indicators':
      return [
        {
          title: copy.knowledgeReads,
          names: ['action', 'sourceId', 'ids', 'query', 'includeProvenance'],
        },
        {
          title: copy.knowledgeWrites,
          names: ['features', 'featuresJson', 'queries', 'queriesJson'],
        },
        paging,
      ];
    case 'events':
      return [
        {
          title: copy.identity,
          names: [
            'action',
            'eventId',
            'eventIds',
            'issueKey',
            'status',
            'includeInactive',
            'separateFromEventIds',
            'distinctProblemReason',
          ],
        },
        {
          title: copy.evidence,
          names: [
            'sourceIds',
            'evidenceRefs',
            'outcome',
            'outcomes',
            'featureIds',
            'causalFeatureIds',
            'queryIds',
            'ruleIds',
            'signalRefs',
          ],
        },
        {
          title: copy.assessment,
          names: ['title', 'summary', 'assessmentNote', 'hypothesis', 'severity', 'confidence'],
        },
        paging,
      ];
    default:
      return [{ title: copy.general, names: [] }];
  }
};

const SchemaField = ({
  name,
  field,
  required,
  depth = 0,
}: {
  name: string;
  field: Parameter;
  required: boolean;
  depth?: number;
}): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  const bounds = (
    [
      ['minimum', copy.minimum],
      ['maximum', copy.maximum],
      ['minLength', copy.minLength],
      ['maxLength', copy.maxLength],
      ['minItems', copy.minItems],
      ['maxItems', copy.maxItems],
      ['multipleOf', copy.multipleOf],
      ['pattern', copy.pattern],
      ['format', copy.format],
      ['default', copy.defaultValue],
    ] as const
  ).filter(([key]) => field[key] !== undefined);
  const values = 'enum' in field ? field.enum : undefined;
  const nested =
    field.type === 'object'
      ? field
      : field.type === 'array' && field.items?.type === 'object'
      ? field.items
      : undefined;
  return (
    <article
      aria-label={name}
      css={css`
        border: ${euiTheme.border.thin};
        border-radius: ${euiTheme.border.radius.medium};
        padding: ${euiTheme.size.m};
        min-width: 0;
        overflow-wrap: anywhere;
      `}
    >
      <div
        css={css`
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: ${euiTheme.size.s};
        `}
      >
        <EuiCode>{name}</EuiCode>
        <EuiBadge color="hollow">
          {field.type}
          {field.type === 'array' && field.items ? ` · ${field.items.type}` : ''}
        </EuiBadge>
        {required && <EuiBadge color="primary">{copy.required}</EuiBadge>}
      </div>
      {field.description && (
        <>
          <EuiSpacer size="s" />
          <EuiText size="xs">
            <p>
              {field.description.length <= 180
                ? field.description
                : field.description.slice(0, 180) + '…'}
            </p>
          </EuiText>
          {field.description.length > 180 && (
            <details>
              <summary
                css={css`
                  cursor: pointer;
                  font-size: ${euiTheme.size.m};
                  color: ${euiTheme.colors.primaryText};
                `}
              >
                {copy.showDescription}
              </summary>
              <EuiText size="xs">
                <p>{field.description}</p>
              </EuiText>
            </details>
          )}
        </>
      )}
      {Boolean(values?.length) && (
        <>
          <EuiSpacer size="s" />
          <div
            aria-label={copy.values}
            css={css`
              display: flex;
              flex-wrap: wrap;
              gap: ${euiTheme.size.xs};
            `}
          >
            {values?.map((value) => (
              <EuiBadge key={value} color="hollow">
                {value}
              </EuiBadge>
            ))}
          </div>
        </>
      )}
      {Boolean(bounds.length) && (
        <dl
          css={css`
            display: flex;
            flex-wrap: wrap;
            gap: ${euiTheme.size.s} ${euiTheme.size.m};
            margin-top: ${euiTheme.size.s};
            font-size: ${euiTheme.size.m};
          `}
        >
          {bounds.map(([key, label]) => (
            <div key={key}>
              <dt
                css={css`
                  color: ${euiTheme.colors.textSubdued};
                `}
              >
                {label}
              </dt>
              <dd>{String(field[key])}</dd>
            </div>
          ))}
        </dl>
      )}
      {nested && depth < 3 && (
        <details
          css={css`
            margin-top: ${euiTheme.size.s};
          `}
        >
          <summary
            css={css`
              cursor: pointer;
              font-size: ${euiTheme.size.m};
            `}
          >
            {field.type === 'array' ? copy.itemFields : copy.objectFields} (
            {Object.keys(nested.properties).length})
          </summary>
          <div
            css={css`
              display: grid;
              gap: ${euiTheme.size.s};
              margin-top: ${euiTheme.size.s};
            `}
          >
            {Object.entries(nested.properties).map(([key, value]) => (
              <SchemaField
                key={key}
                name={key}
                field={value}
                required={nested.required?.includes(key) ?? false}
                depth={depth + 1}
              />
            ))}
          </div>
        </details>
      )}
    </article>
  );
};

const ToolDetail = ({ tool }: { tool: AnatomyTool }): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  const properties = tool.schema?.properties ?? {};
  const assigned = new Set<string>();
  const groups = groupsFor(tool.name).flatMap((group) => {
    const names = group.names.filter((name) => name in properties);
    names.forEach((name) => assigned.add(name));
    return names.length ? [{ ...group, names }] : [];
  });
  const remaining = Object.keys(properties).filter((name) => !assigned.has(name));
  if (remaining.length)
    groups.push({
      title: groups.length ? copy.otherParameters : copy.parameters,
      names: remaining,
    });
  const actions = properties.action;
  return (
    <div>
      <EuiTitle size="s">
        <h4>{tool.name}</h4>
      </EuiTitle>
      <EuiSpacer size="s" />
      <EuiText size="s">
        <p>{tool.description.split(/(?<=[.!?])\s/)[0]}</p>
      </EuiText>
      <EuiSpacer size="m" />
      {actions && 'enum' in actions && actions.enum && (
        <>
          <EuiText size="xs">
            <strong>{copy.operations}</strong>
          </EuiText>
          <EuiSpacer size="s" />
          <div
            css={css`
              display: flex;
              flex-wrap: wrap;
              gap: ${euiTheme.size.xs};
            `}
          >
            {actions.enum.map((action) => (
              <EuiBadge key={action} color="hollow">
                {action}
              </EuiBadge>
            ))}
          </div>
          <EuiSpacer size="l" />
        </>
      )}
      {!groups.length && (
        <EuiText color="subdued" size="s">
          <p>{copy.noParameters}</p>
        </EuiText>
      )}
      {groups.map((group) => (
        <section
          key={group.title}
          css={css`
            margin-bottom: ${euiTheme.size.l};
          `}
        >
          <EuiTitle size="xxs">
            <h5>{group.title}</h5>
          </EuiTitle>
          <EuiSpacer size="s" />
          <div
            css={css`
              display: grid;
              grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
              gap: ${euiTheme.size.s};
            `}
          >
            {group.names.map((name) => (
              <SchemaField
                key={name}
                name={name}
                field={properties[name]}
                required={tool.schema?.required?.includes(name) ?? false}
              />
            ))}
          </div>
        </section>
      ))}
      <EuiAccordion
        id={`${tool.name}-instructions`}
        buttonContent={copy.toolInstructions}
        paddingSize="m"
      >
        <EuiText size="s">
          <p
            css={css`
              white-space: pre-wrap;
            `}
          >
            {tool.description}
          </p>
        </EuiText>
      </EuiAccordion>
      <EuiSpacer size="m" />
      <EuiAccordion
        id={`${tool.name}-definition`}
        buttonContent={copy.rawDefinition}
        paddingSize="m"
      >
        <EuiCodeBlock language="json" isCopyable>
          {JSON.stringify(tool.schema ?? {}, null, 2)}
        </EuiCodeBlock>
      </EuiAccordion>
    </div>
  );
};

export const ToolAnatomy = ({
  tools,
  onNavigate,
}: {
  tools: AnatomyTool[];
  onNavigate?: () => void;
}): React.ReactElement => {
  const { euiTheme } = useEuiTheme();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(tools[0]?.name);
  const visible = tools.filter((tool) =>
    `${tool.name} ${tool.description}`.toLowerCase().includes(query.toLowerCase())
  );
  const current = visible.find((tool) => tool.name === selected) ?? visible[0];
  if (!tools.length)
    return (
      <EuiText color="subdued">
        <p>{copy.noTools}</p>
      </EuiText>
    );
  return (
    <div>
      <EuiFieldSearch
        data-test-subj="nightshiftAgentAnatomyToolSearch"
        aria-label={copy.findTool}
        placeholder={copy.findTool}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        fullWidth
        isClearable
      />
      <EuiSpacer size="m" />
      {!current ? (
        <EuiText color="subdued">
          <p>{copy.noToolMatches}</p>
        </EuiText>
      ) : (
        <div
          css={css`
            display: grid;
            grid-template-columns: 190px minmax(0, 1fr);
            gap: ${euiTheme.size.l};
            @media (max-width: 900px) {
              grid-template-columns: 1fr;
            }
          `}
        >
          <div
            css={css`
              display: none;
              @media (max-width: 900px) {
                display: block;
              }
            `}
          >
            <EuiSelect
              {...getEbtProps({ action: 'selectTool', element: 'agentAnatomy' })}
              data-test-subj="nightshiftAgentAnatomyToolSelect"
              aria-label={copy.tools}
              value={current.name}
              fullWidth
              options={visible.map((tool) => ({ value: tool.name, text: tool.name }))}
              onChange={(event) => {
                setSelected(event.target.value);
                onNavigate?.();
              }}
            />
          </div>
          <nav
            aria-label={copy.tools}
            css={css`
              position: sticky;
              align-self: start;
              top: 0;
              max-height: calc(100dvh - 380px);
              overflow: auto;
              @media (max-width: 900px) {
                display: none;
                position: static;
                max-height: 180px;
                overflow: auto;
              }
            `}
          >
            {visible.map((tool) => (
              <button
                {...getEbtProps({ action: 'selectTool', element: 'agentAnatomy' })}
                key={tool.name}
                type="button"
                aria-pressed={tool.name === current.name}
                onClick={() => {
                  setSelected(tool.name);
                  onNavigate?.();
                }}
                css={css`
                  display: block;
                  width: 100%;
                  text-align: left;
                  overflow-wrap: anywhere;
                  border-left: 2px solid
                    ${tool.name === current.name ? euiTheme.colors.primary : 'transparent'};
                  background: ${tool.name === current.name
                    ? euiTheme.colors.backgroundBaseSubdued
                    : 'transparent'};
                  padding: ${euiTheme.size.s};
                  margin-bottom: ${euiTheme.size.xs};
                  font-size: ${euiTheme.size.m};
                  color: ${tool.name === current.name
                    ? euiTheme.colors.primaryText
                    : euiTheme.colors.text};
                `}
              >
                {tool.name}
              </button>
            ))}
          </nav>
          <ToolDetail key={current.name} tool={current} />
        </div>
      )}
    </div>
  );
};
