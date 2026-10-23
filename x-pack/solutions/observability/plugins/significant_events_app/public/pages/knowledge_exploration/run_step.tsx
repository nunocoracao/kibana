/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import React, { useId, useState } from 'react';
import { i18n } from '@kbn/i18n';
import { css } from '@emotion/react';
import {
  EuiBadge,
  EuiCode,
  EuiCodeBlock,
  EuiFlexGroup,
  EuiFlexItem,
  EuiIcon,
  EuiLoadingSpinner,
  EuiScreenReaderOnly,
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
  const detailsId = useId();
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
      : euiTheme.colors.textSubdued;
  const duration = running ? Math.max(0, Date.now() - Date.parse(step.startedAt)) : step.durationMs;
  const commentary = model ? step.output : '';
  return (
    <div
      data-test-subj="agentExplorerStep"
      css={css`
        display: grid;
        grid-template-columns: 24px minmax(0, 1fr);
        gap: ${euiTheme.size.s};
        padding: ${euiTheme.size.m} 0;
        border-bottom: ${euiTheme.border.thin};
      `}
    >
      <div
        css={css`
          position: relative;
          display: flex;
          justify-content: center;
          padding-top: 3px;
          &::after {
            content: '';
            position: absolute;
            width: 1px;
            top: 24px;
            bottom: -16px;
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
            color: ${color};
          `}
        >
          {running ? (
            <EuiLoadingSpinner size="s" />
          ) : (
            <EuiIcon
              size="s"
              type={
                description.status === 'failed' || description.status === 'partial'
                  ? 'warning'
                  : model
                  ? 'sparkles'
                  : 'check'
              }
              color={color}
              aria-hidden={true}
            />
          )}
        </div>
      </div>
      <div
        css={css`
          min-width: 0;
        `}
      >
        <button
          type="button"
          aria-label={
            expanded ? 'Hide details' : model ? 'Commentary and usage' : 'Inspect tool call'
          }
          aria-expanded={expanded}
          aria-controls={detailsId}
          data-test-subj="significantEventsAppStepButton"
          onClick={() => {
            if (!expanded) onInspect();
            setExpanded(!expanded);
          }}
          css={css`
            display: flex;
            align-items: center;
            gap: ${euiTheme.size.s};
            width: 100%;
            min-height: ${euiTheme.size.l};
            padding: 0;
            border: 0;
            border-radius: ${euiTheme.border.radius.small};
            background: transparent;
            color: ${euiTheme.colors.textParagraph};
            text-align: left;
            cursor: pointer;
            &:hover {
              color: ${euiTheme.colors.primaryText};
            }
            &:focus-visible {
              outline: ${euiTheme.focus.width} solid ${euiTheme.colors.primary};
              outline-offset: ${euiTheme.size.xs};
            }
          `}
        >
          <span
            css={css`
              flex: 1;
              min-width: 0;
              font-size: ${euiTheme.font.scale.s}rem;
              font-weight: ${euiTheme.font.weight.semiBold};
              overflow: hidden;
              text-overflow: ellipsis;
              white-space: nowrap;
            `}
            title={description.title}
          >
            {description.title}
          </span>
          {description.status !== 'completed' ? (
            <EuiBadge
              color={
                description.status === 'failed'
                  ? 'danger'
                  : description.status === 'partial'
                  ? 'warning'
                  : 'primary'
              }
            >
              {description.status}
            </EuiBadge>
          ) : (
            <EuiScreenReaderOnly>
              <span>{description.status}</span>
            </EuiScreenReaderOnly>
          )}
          <span
            css={css`
              color: ${euiTheme.colors.textSubdued};
              font-size: ${euiTheme.font.scale.xs}rem;
              font-variant-numeric: tabular-nums;
              white-space: nowrap;
            `}
          >
            {(duration / 1000).toFixed(1)}s
          </span>
          <EuiIcon
            type={expanded ? 'arrowDown' : 'arrowRight'}
            size="s"
            color="subdued"
            aria-hidden={true}
          />
        </button>
        {(description.scope || (model && previousTool)) && (
          <EuiText
            size="xs"
            color="subdued"
            css={css`
              margin-top: ${euiTheme.size.xs};
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
        {!model && description.result && (
          <EuiText
            size="xs"
            color={
              description.status === 'failed'
                ? 'danger'
                : description.status === 'partial'
                ? 'warning'
                : 'default'
            }
            css={css`
              margin-top: ${euiTheme.size.xs};
            `}
          >
            {description.result}
          </EuiText>
        )}
        {!expanded && description.queryPreview && (
          <code
            css={css`
              display: -webkit-box;
              -webkit-line-clamp: 2;
              -webkit-box-orient: vertical;
              overflow: hidden;
              overflow-wrap: anywhere;
              white-space: pre-wrap;
              margin-top: ${euiTheme.size.s};
              padding: ${euiTheme.size.s};
              border-radius: ${euiTheme.border.radius.small};
              background: ${euiTheme.colors.backgroundBaseSubdued};
              color: ${euiTheme.colors.textSubdued};
              font-family: ${euiTheme.font.familyCode};
              font-size: ${euiTheme.font.scale.xs}rem;
              line-height: 1.5;
            `}
            title={description.queryPreview}
          >
            {description.queryPreview}
          </code>
        )}
        {description.items.length > 0 && (
          <EuiText
            size="xs"
            css={css`
              margin-top: ${euiTheme.size.xs};
              overflow-wrap: anywhere;
              ${!expanded &&
              'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;'}
            `}
            title={description.items.join(' · ')}
          >
            {description.itemLabel && <strong>{description.itemLabel}: </strong>}
            {description.items.join(' · ')}
          </EuiText>
        )}
        {description.note && (
          <EuiText
            size="xs"
            color="subdued"
            css={css`
              margin-top: ${euiTheme.size.xs};
              overflow-wrap: anywhere;
              ${!expanded &&
              'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;'}
            `}
            title={description.note}
          >
            {description.note}
          </EuiText>
        )}
        {description.error && (
          <EuiText
            size="xs"
            color="danger"
            css={css`
              margin-top: ${euiTheme.size.xs};
              overflow-wrap: anywhere;
              ${!expanded &&
              'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;'}
            `}
          >
            {description.error}
          </EuiText>
        )}
        {commentary && (
          <EuiText
            size="s"
            css={css`
              white-space: pre-wrap;
              margin-top: ${euiTheme.size.s};
              line-height: 1.6;
              overflow-wrap: anywhere;
              ${!expanded &&
              'display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;'}
            `}
          >
            {commentary}
          </EuiText>
        )}
        <div id={detailsId} hidden={!expanded}>
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
                  <EuiFlexGroup
                    alignItems="center"
                    justifyContent="spaceBetween"
                    gutterSize="s"
                    responsive={false}
                  >
                    <EuiFlexItem grow={false}>
                      <EuiCode>{step.name}</EuiCode>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>
                      <EuiText size="xs" color="subdued">
                        {new Date(step.startedAt).toLocaleTimeString()}
                      </EuiText>
                    </EuiFlexItem>
                  </EuiFlexGroup>
                  <EuiSpacer size="s" />
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
                    overflowHeight={240}
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
                    overflowHeight={400}
                    isCopyable
                  >
                    {formatted(step.output)}
                  </EuiCodeBlock>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
