/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { ExplorationStep } from '@kbn/significant-events-plugin/common';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' ? value : array(value).length);
export const parseStepValue = (value: string): ObjectValue => {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
};
const names = (values: unknown[]): string => {
  const labels = values.map(text).filter(Boolean);
  return labels.slice(0, 3).join(', ') + (labels.length > 3 ? ` +${labels.length - 3}` : '');
};

export const getStepDescription = (step: ExplorationStep) => {
  const input = parseStepValue(step.input);
  const output = parseStepValue(step.output);
  const results = array(output.results).map(object);
  const errors = [output.error, ...results.map((result) => result.error)].map(text).filter(Boolean);
  const rejected = array(output.rejected);
  const saved = array(output.saved);
  const status =
    rejected.length || errors.length || output.failed
      ? saved.length || results.some((result) => !result.error)
        ? 'partial'
        : 'failed'
      : step.status;
  const action = text(input.action);
  const template = text(input.template);
  const sum = (field: string) => results.reduce((total, result) => total + count(result[field]), 0);
  let title = step.name.replaceAll('_', ' ');
  let result = '';
  let items: string[] = [];
  const scope = [names(array(input.serviceNames)), text(input.serviceNamespace)];
  if (typeof input.lookbackMinutes === 'number') {
    const minutes = input.lookbackMinutes;
    scope.push(
      minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h of data` : `${minutes}m of data`
    );
  }
  if (step.kind === 'model') {
    const turn = step.name.match(/\d+/)?.[0];
    title = `${step.status === 'running' ? 'Thinking' : 'Model response'}${
      turn ? ` · turn ${turn}` : ''
    }`;
  } else if (step.name === 'detection_sources') {
    title = 'Discover configured sources';
    result = `${count(output.total ?? output.sources)} sources`;
    items = array(output.sources)
      .map((source) => text(object(source).title))
      .filter(Boolean);
  } else if (step.name === 'source_esql') {
    title =
      (
        {
          novelty: 'Check for new knowledge',
          schema: 'Inspect source fields and types',
          inventory: 'Discover services and deployments',
          patterns: 'Discover log categories',
          relationships: 'Investigate dependencies',
          infrastructure: 'Map infrastructure',
          samples: `Read ${text(input.sampleKind) || 'representative'} logs`,
          custom: 'Run a focused source query',
        } as Record<string, string>
      )[template] ?? 'Explore source evidence';
    if (template === 'custom') scope.push(text(input.pipeline));
    if (template === 'schema') result = `${sum('totalColumns')} fields · ${sum('columns')} shown`;
    else if (template === 'novelty' || template === 'inventory')
      result = `${sum('serviceGroups')} service groups · ${sum(
        'patternGroups'
      )} log categories · ${sum('entityGapCount')} new entities`;
    else result = `${sum('rows')} rows`;
    if (results.some((entry) => entry.truncated || entry.hasMore)) result += ' · more available';
    items = results
      .flatMap((entry) => array(entry.rows))
      .flatMap((row) => {
        const service = object(object(row).service);
        return text(service.name) ? [text(service.name)] : [];
      });
  } else if (step.name === 'knowledge_indicators') {
    title =
      action === 'upsert'
        ? 'Save learned knowledge'
        : action === 'read'
        ? 'Inspect selected KIs'
        : 'Read the knowledge index';
    if (action === 'upsert') {
      result = `${saved.length} saved · ${array(output.unchanged).length} unchanged · ${
        rejected.length
      } rejected`;
      let features = array(input.features);
      try {
        if (input.featuresJson) features = array(JSON.parse(text(input.featuresJson)));
      } catch {
        /* Raw malformed input remains available in details. */
      }
      items = saved.map((entry) => {
        const id = text(object(entry).id);
        return text(object(features.find((feature) => object(feature).id === id)).title) || id;
      });
    } else {
      result = `${count(output.total ?? output.features ?? output.records)} KIs${
        output.hasMore ? ' · more available' : ''
      }`;
      items = array(output.features ?? output.records).map((entry) => text(object(entry).title));
    }
  } else if (step.name === 'kibana_information') {
    title =
      action === 'catalog'
        ? 'Find Kibana capabilities'
        : action === 'describe'
        ? 'Inspect a Kibana tool'
        : 'Query Kibana context';
    scope.push(text(input.toolId).replaceAll('_', ' '), text(input.query));
    if (action === 'catalog') result = `${array(output.tools).length} available tools`;
    else if (action === 'describe') result = 'Input schema available';
    else result = `${results.length} result groups`;
  } else if (step.name === 'monitoring_inventory') {
    title = 'Review existing monitoring';
    result = `${count(output.total ?? output.rules)} rules${
      output.hasMore ? ' · more available' : ''
    }`;
    items = array(output.rules).map((rule) => text(object(rule).name));
  } else if (step.name === 'monitoring_rules') {
    title =
      (
        {
          baseline: 'Measure a monitoring baseline',
          validate: 'Test a monitoring query',
          upsert: 'Create or update a managed rule',
          enable: 'Enable a managed rule',
          disable: 'Disable a managed rule',
          delete: 'Remove a managed rule',
        } as Record<string, string>
      )[action] ?? 'Maintain monitoring';
    scope.push(text(input.title), text(input.reason));
    if (action === 'upsert')
      result = output.unchanged ? 'Rule already matches' : `${saved.length} rule saved`;
    else if (action === 'baseline') result = `${array(output.groups).length} baseline groups`;
    else if (action === 'validate') result = 'Validation result available';
    else result = output.ruleId ? `Rule ${action} completed` : '';
  } else if (step.name === 'fired_rules') {
    title = action === 'read' ? 'Inspect selected rule signals' : 'Review recent rule firings';
    scope.push('Last 30 minutes');
    result = `${count(output.total ?? output.signals ?? output.groups)} signal groups`;
  } else if (step.name === 'rule_change_points') {
    title = 'Investigate changes in a metric';
    result = 'Change-point analysis available';
  } else if (step.name === 'events') {
    title =
      action === 'upsert'
        ? `${input.status === 'active' ? 'Activate' : 'Record inactive'} event assessment`
        : action === 'read'
        ? 'Inspect event assessments'
        : 'Review existing event assessments';
    scope.push(text(input.title));
    result =
      action === 'upsert'
        ? output.unchanged
          ? 'Assessment unchanged'
          : `Assessment saved · ${text(output.status) || text(input.status)}`
        : `${count(output.total ?? output.events)} assessments`;
  } else if (step.name === 'finish_exploration') {
    title = 'Complete the run';
    result = text(output.outcome ?? input.outcome).replaceAll('_', ' ');
    scope.push(text(input.summary));
    items = array(input.remainingGaps).map(text);
  }
  if (output.truncated) result = 'Result truncated · inspect tool call';
  if (step.status === 'running') result = '';
  if (!step.output && step.status !== 'running') result = 'No result recorded';
  const error =
    errors[0] ||
    text(object(rejected[0]).reason) ||
    (status === 'failed' ? step.output.slice(0, 400) : '');
  return {
    title,
    scope: scope.filter(Boolean).join(' · '),
    result,
    items: [...new Set(items.filter(Boolean))].slice(0, 4),
    status,
    error,
  };
};
