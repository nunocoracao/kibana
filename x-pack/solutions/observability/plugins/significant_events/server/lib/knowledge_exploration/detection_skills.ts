/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import { defineSkillType } from '@kbn/agent-builder-server/skills/type_definition';
import { CONFIDENCE_CONTRACT_RULE, SEVERITY_CONTRACT_RULE } from '@kbn/significant-events-schema';
import investigate from './investigate_symptoms.md.text';
import lifecycle from './manage_events.md.text';
import coverage from './maintain_coverage.md.text';

const basePath = 'skills/observability/nightshift';
export const detectionSkills = [
  defineSkillType({
    id: 'nightshift-investigate-symptoms',
    name: 'investigate-symptoms',
    basePath,
    description:
      'Measure current impact, compare a healthy baseline, and distinguish routine outcomes from real failures.',
    content: investigate,
  }),
  defineSkillType({
    id: 'nightshift-manage-events',
    name: 'manage-events',
    basePath,
    description:
      'Identify an occurrence, open or review an event, rate impact, and verify recovery.',
    content: [
      lifecycle,
      '## Severity',
      SEVERITY_CONTRACT_RULE,
      '## Confidence',
      CONFIDENCE_CONTRACT_RULE,
    ].join('\n\n'),
  }),
  defineSkillType({
    id: 'nightshift-maintain-coverage',
    name: 'maintain-coverage',
    basePath,
    description:
      'Persist learned knowledge and turn a proven symptom into a validated native rule.',
    content: coverage,
  }),
];
