/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useState } from 'react';
import { i18n } from '@kbn/i18n';
import { css } from '@emotion/react';
import {
  EuiBadge,
  EuiButtonEmpty,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiLoadingSpinner,
  EuiPanel,
  EuiSpacer,
  EuiText,
  useEuiTheme,
} from '@elastic/eui';
import type { ExplorationStep } from '@kbn/significant-events-plugin/common';
import { getStepDescription } from './step_summary';

const formatted = (value: string) => {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

export function RunStep({
  step,
  previousTool,
  onInspect,
}: {
  step: ExplorationStep;
  previousTool?: ExplorationStep;
  onInspect: () => void;
}) {
  const { euiTheme } = useEuiTheme();
  const [expanded, setExpanded] = useState(false);
  const description = getStepDescription(step);
  const model = step.kind === 'model';
  const running = description.status === 'running';
  const color =
    description.status === 'failed'
      ? euiTheme.colors.danger
      : description.status === 'partial'
      ? euiTheme.colors.warning
      : model
      ? euiTheme.colors.vis.euiColorVis0
      : euiTheme.colors.primary;
  const duration = running ? Math.max(0, Date.now() - Date.parse(step.startedAt)) : step.durationMs;
  const commentary = model ? step.output : '';
  return (
    <div
      data-test-subj="agentExplorerStep"
      css={css`
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        gap: 8px;
        margin-bottom: 8px;
      `}
    >
      <div
        css={css`
          position: relative;
          display: flex;
          justify-content: center;
          padding-top: 10px;
          &::after {
            content: '';
            position: absolute;
            width: 1px;
            top: 30px;
            bottom: -18px;
            background: ${euiTheme.border.color};
          }
        `}
      >
        <div
          css={css`
            width: 20px;
            height: 20px;
            display: grid;
            place-items: center;
            border-radius: 50%;
            border: 1px solid ${color};
            color: ${color};
          `}
        >
          {running ? (
            <EuiLoadingSpinner size="s" />
          ) : (
            <EuiIcon
              size="s"
              type={description.status === 'failed' ? 'warning' : model ? 'sparkles' : 'check'}
              color={color}
              aria-hidden={true}
            />
          )}
        </div>
      </div>
      <EuiPanel
        paddingSize="s"
        hasShadow={false}
        hasBorder={!model || running}
        css={css`
          min-width: 0;
          flex: 0 0 auto;
          border-left: 2px solid ${color};
          background: ${model
            ? euiTheme.colors.backgroundBaseSubdued
            : euiTheme.colors.backgroundBasePlain};
        `}
      >
        <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false}>
          <EuiFlexItem
            css={css`
              min-width: 0;
            `}
          >
            <EuiText size="s">
              <strong>{description.title}</strong>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiBadge
              color={
                description.status === 'failed'
                  ? 'danger'
                  : description.status === 'partial'
                  ? 'warning'
                  : running
                  ? 'primary'
                  : 'hollow'
              }
            >
              {description.status}
            </EuiBadge>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              {(duration / 1000).toFixed(1)}s
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>
        {(description.scope || (model && previousTool)) && (
          <EuiText
            size="xs"
            color="subdued"
            css={css`
              margin-top: 3px;
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            `}
            title={description.scope}
          >
            {model && previousTool
              ? `After: ${getStepDescription(previousTool).title}`
              : description.scope}
          </EuiText>
        )}
        {description.result && !model && (
          <EuiText
            size="xs"
            color={
              description.status === 'failed'
                ? 'danger'
                : description.status === 'partial'
                ? 'warning'
                : 'subdued'
            }
            css={css`
              margin-top: 4px;
            `}
          >
            {description.result}
          </EuiText>
        )}
        {description.items.length > 0 && (
          <EuiText
            size="xs"
            css={css`
              margin-top: 4px;
            `}
          >
            {description.items.join(' · ')}
          </EuiText>
        )}
        {description.error && (
          <EuiText
            size="xs"
            color="danger"
            css={css`
              margin-top: 4px;
              overflow-wrap: anywhere;
            `}
          >
            {description.error.slice(0, 400)}
          </EuiText>
        )}
        {commentary && (
          <EuiText
            size="s"
            css={css`
              white-space: pre-wrap;
              margin-top: 6px;
              overflow-wrap: anywhere;
              ${!expanded &&
              'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;'}
            `}
          >
            {commentary}
          </EuiText>
        )}
        <EuiButtonEmpty
          size="xs"
          iconType={expanded ? 'arrowDown' : 'arrowRight'}
          data-test-subj="significantEventsAppStepButton"
          onClick={() => {
            if (!expanded) onInspect();
            setExpanded(!expanded);
          }}
          css={css`
            padding-left: 0;
            margin-top: 4px;
          `}
        >
          {expanded ? 'Hide details' : model ? 'Commentary and usage' : 'Inspect tool call'}
        </EuiButtonEmpty>
        {expanded && (
          <>
            <EuiSpacer size="s" />
            {model ? (
              <>
                {!commentary && (
                  <EuiText size="xs" color="subdued">
                    {i18n.translate(
                      'xpack.significantEventsApp.runStep.thisModelReturnedNoTextLabel',
                      {
                        defaultMessage:
                          'This model returned no commentary for this turn. Private thinking text is not included in the run trace.',
                      }
                    )}
                  </EuiText>
                )}
                <EuiText size="xs" color="subdued">
                  {step.input}
                </EuiText>
                {step.tokens && (
                  <EuiText size="xs" color="subdued">
                    {step.tokens.prompt.toLocaleString()}{' '}
                    {i18n.translate('xpack.significantEventsApp.runStep.inputTextLabel', {
                      defaultMessage: 'input ·',
                    })}{' '}
                    {step.tokens.completion.toLocaleString()}{' '}
                    {i18n.translate('xpack.significantEventsApp.runStep.outputTextLabel', {
                      defaultMessage: 'output ·',
                    })}{' '}
                    {step.tokens.cached.toLocaleString()}{' '}
                    {i18n.translate('xpack.significantEventsApp.runStep.cachedTextLabel', {
                      defaultMessage: 'cached ·',
                    })}{' '}
                    {step.tokens.thinking
                      ? `${step.tokens.thinking.toLocaleString()} thinking`
                      : 'Thinking tokens not reported'}{' '}
                    ·{' '}
                    {step.estimatedCostUsd === undefined
                      ? 'Cost unavailable'
                      : `$${step.estimatedCostUsd.toFixed(4)}`}
                  </EuiText>
                )}
              </>
            ) : (
              <>
                <EuiText size="xs">
                  <strong>
                    {i18n.translate('xpack.significantEventsApp.runStep.strong.inputLabel', {
                      defaultMessage: 'Input',
                    })}
                  </strong>
                </EuiText>
                <EuiCodeBlock
                  language="json"
                  fontSize="s"
                  paddingSize="s"
                  overflowHeight={200}
                  isCopyable
                >
                  {formatted(step.input)}
                </EuiCodeBlock>
                <EuiSpacer size="s" />
                <EuiText size="xs">
                  <strong>
                    {i18n.translate('xpack.significantEventsApp.runStep.strong.resultLabel', {
                      defaultMessage: 'Result',
                    })}
                  </strong>
                </EuiText>
                <EuiCodeBlock
                  language="json"
                  fontSize="s"
                  paddingSize="s"
                  overflowHeight={280}
                  isCopyable
                >
                  {formatted(step.output)}
                </EuiCodeBlock>
              </>
            )}
          </>
        )}
      </EuiPanel>
    </div>
  );
}
