/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { EuiBadge, EuiButtonEmpty, EuiPanel, EuiSpacer, EuiText } from '@elastic/eui';
import { i18n } from '@kbn/i18n';
import type { ExplorationStep } from '@kbn/significant-events-plugin/common';
import React, { useState } from 'react';
import { RunStep } from './run_step';

function field(json: string, key: string): string {
  try {
    const value = JSON.parse(json)?.[key];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export const specialistName = (step: ExplorationStep) => {
  const role = field(step.input, 'specialist');
  if (role === 'knowledge_extractor') return 'Knowledge Extractor';
  if (role === 'rule_setter') return 'Rule Setter';
  return i18n.translate('xpack.nightshift.specialist.unknown', { defaultMessage: 'Specialist' });
};

export function groupActivity(steps: ExplorationStep[]) {
  const groups: Array<{ step: ExplorationStep; children: ExplorationStep[] }> = [];
  const handoffs = new Map<string, ExplorationStep[]>();
  let lastHandoff: ExplorationStep | undefined;
  for (const step of steps) {
    // Foreground traces saved before parentStepId used the specialist model step and its time window.
    const legacyChild =
      lastHandoff &&
      (step.kind === 'tool' || step.name === specialistName(lastHandoff)) &&
      (lastHandoff.status === 'running' ||
        Date.parse(step.startedAt) < Date.parse(lastHandoff.startedAt) + lastHandoff.durationMs);
    const children = handoffs.get(step.parentStepId ?? (legacyChild ? lastHandoff?.id : '') ?? '');
    if (children && step.name !== 'delegate_specialist') {
      children.push(step);
      continue;
    }
    const group = { step, children: [] as ExplorationStep[] };
    groups.push(group);
    lastHandoff = step.name === 'delegate_specialist' ? step : undefined;
    if (lastHandoff) handoffs.set(step.id, group.children);
  }
  return groups;
}

export function SpecialistActivity({
  step,
  childrenSteps,
  showModels,
  onInspect,
}: {
  step: ExplorationStep;
  childrenSteps: ExplorationStep[];
  showModels: boolean;
  onInspect: () => void;
}) {
  const active = step.status === 'running';
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? active;
  const report = field(step.output, 'report') || field(step.output, 'error');
  return (
    <EuiPanel hasBorder paddingSize="s">
      <EuiButtonEmpty
        size="s"
        iconType={open ? 'arrowDown' : 'arrowRight'}
        aria-expanded={open}
        onClick={() => setExpanded(!open)}
      >
        {specialistName(step)}
      </EuiButtonEmpty>{' '}
      <EuiBadge color={active ? 'primary' : step.status === 'failed' ? 'danger' : 'hollow'}>
        {step.status}
      </EuiBadge>
      {open && (
        <>
          <EuiText size="xs">
            <p>{field(step.input, 'task')}</p>
          </EuiText>
          {childrenSteps
            .filter((child) => child.kind === 'tool' || showModels)
            .map((child) => (
              <RunStep key={child.id} step={child} onInspect={onInspect} />
            ))}
          {report &&
            (!showModels ||
              !childrenSteps.some(
                (child) => child.kind === 'model' && child.output === report
              )) && (
              <>
                <EuiSpacer size="s" />
                <EuiText size="s">
                  <p>{report}</p>
                </EuiText>
              </>
            )}
        </>
      )}
    </EuiPanel>
  );
}
