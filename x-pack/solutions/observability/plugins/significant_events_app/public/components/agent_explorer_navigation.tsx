/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React from 'react';
import { css } from '@emotion/react';
import { EuiIcon, useEuiTheme } from '@elastic/eui';
import { i18n } from '@kbn/i18n';

export const agentExplorerOptions = [
  {
    id: 'knowledge',
    label: i18n.translate('xpack.significantEventsApp.agentNavigation.knowledge', {
      defaultMessage: 'Knowledge Extractor',
    }),
    description: i18n.translate('xpack.significantEventsApp.agentNavigation.knowledgeDescription', {
      defaultMessage: 'Understand your system',
    }),
    iconType: 'sparkles',
  },
  {
    id: 'monitoring',
    label: i18n.translate('xpack.significantEventsApp.agentNavigation.monitoring', {
      defaultMessage: 'Monitoring Setup',
    }),
    description: i18n.translate(
      'xpack.significantEventsApp.agentNavigation.monitoringDescription',
      {
        defaultMessage: 'Cover monitoring gaps',
      }
    ),
    iconType: 'bolt',
  },
  {
    id: 'events',
    label: i18n.translate('xpack.significantEventsApp.agentNavigation.events', {
      defaultMessage: 'Event Discovery',
    }),
    description: i18n.translate('xpack.significantEventsApp.agentNavigation.eventsDescription', {
      defaultMessage: 'Assess significant events',
    }),
    iconType: 'bell',
  },
] as const;

type AgentId = (typeof agentExplorerOptions)[number]['id'];

export function AgentExplorerNavigation({
  agent,
  onAgentChange,
}: {
  agent: AgentId;
  onAgentChange: (agent: AgentId) => void;
}) {
  const { euiTheme } = useEuiTheme();
  return (
    <div
      role="group"
      aria-label={i18n.translate('xpack.significantEventsApp.agentNavigation.label', {
        defaultMessage: 'Select an agent',
      })}
      css={css`
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: ${euiTheme.size.s};
        flex: 0 0 auto;
        @media (max-width: 520px) {
          grid-template-columns: 1fr;
        }
      `}
    >
      {agentExplorerOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-label={option.label}
          aria-pressed={agent === option.id}
          title={option.description}
          onClick={() => onAgentChange(option.id)}
          css={css`
            display: flex;
            align-items: center;
            gap: ${euiTheme.size.s};
            min-width: 0;
            padding: ${euiTheme.size.m};
            border: 1px solid
              ${agent === option.id ? euiTheme.colors.primary : euiTheme.border.color};
            border-radius: ${euiTheme.border.radius.medium};
            background: ${agent === option.id
              ? `color-mix(in srgb, ${euiTheme.colors.primary} 8%, ${euiTheme.colors.backgroundBasePlain})`
              : euiTheme.colors.backgroundBasePlain};
            color: ${agent === option.id
              ? euiTheme.colors.primaryText
              : euiTheme.colors.textParagraph};
            text-align: left;
            cursor: pointer;
            &:hover {
              border-color: ${euiTheme.colors.primary};
            }
            &:focus-visible {
              outline: ${euiTheme.focus.width} solid ${euiTheme.colors.primary};
              outline-offset: ${euiTheme.size.xs};
            }
          `}
        >
          <EuiIcon type={option.iconType} size="m" aria-hidden={true} />
          <span
            css={css`
              min-width: 0;
              display: flex;
              flex-direction: column;
              gap: ${euiTheme.size.xs};
            `}
          >
            <span
              css={css`
                font-size: ${euiTheme.font.scale.s}rem;
                font-weight: ${euiTheme.font.weight.semiBold};
              `}
            >
              {option.label}
            </span>
            <span
              css={css`
                font-size: ${euiTheme.font.scale.xs}rem;
                color: ${euiTheme.colors.textSubdued};
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
              `}
            >
              {option.description}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
