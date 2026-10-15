/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

export interface ObservedEntity {
  name: string;
  namespace: string;
}

export interface DependencyCandidate {
  source: string;
  target: string;
  sourceNamespace: string;
  targetNamespace: string;
  basis: 'explicit_endpoint' | 'named_hop_timing' | 'named_call_counter' | 'failed_target';
  protocol?: string;
}

export const rowIdentity = (row: Record<string, string>): ObservedEntity => {
  const resourceName =
    row['resource.attributes.service.name'] || row['service.name'] || row.service_name || '';
  const tag = row['attributes.fluent.tag'] || row['fluent.tag'];
  const dataset = row['data_stream.dataset'] || row['attributes.data_stream.dataset'];
  const taggedDataset = tag?.replaceAll('-', '_');
  const confirmedTag =
    tag && dataset && (dataset === taggedDataset || dataset === `${taggedDataset}.otel`);
  return {
    name: confirmedTag ? tag : resourceName,
    namespace:
      row['resource.attributes.service.namespace'] ||
      row['service.namespace'] ||
      row.namespace ||
      '',
  };
};

/** Extracts bounded directed evidence without interpreting arbitrary JSON keys as dependencies. */
export const dependencyCandidates = (
  row: Record<string, string>,
  entities: ObservedEntity[]
): DependencyCandidate[] => {
  const actor = rowIdentity(row);
  if (!actor.name) return [];
  const text = row.message || row['body.text'] || row.body || row.sample || '';
  const candidates: DependencyCandidate[] = [];
  const resolve = (target: string, namespace = actor.namespace): ObservedEntity | undefined =>
    entities.find((entity) => entity.name === target && entity.namespace === namespace);
  const add = (target: ObservedEntity, basis: DependencyCandidate['basis'], protocol?: string) => {
    if (target.name === actor.name && target.namespace === actor.namespace) return;
    if (
      candidates.some(
        (item) =>
          item.target === target.name &&
          item.targetNamespace === target.namespace &&
          item.basis === basis
      )
    )
      return;
    if (candidates.length < 20)
      candidates.push({
        source: actor.name,
        target: target.name,
        sourceNamespace: actor.namespace,
        targetNamespace: target.namespace,
        basis,
        ...(protocol ? { protocol } : {}),
      });
  };
  const endpoint = (value: string) => {
    const direct = resolve(value);
    if (direct) return { entity: direct };
    try {
      const url = new URL(value);
      const hostname = url.hostname;
      const exact = resolve(hostname);
      if (exact) return { entity: exact, protocol: url.protocol.replace(':', '') };
      const [name, namespace, ...suffix] = hostname.split('.');
      const qualified = suffix.includes('svc') ? resolve(name, namespace) : undefined;
      return {
        entity: qualified ?? { name: hostname, namespace: '' },
        protocol: url.protocol.replace(':', ''),
      };
    } catch {
      return undefined;
    }
  };
  const values: string[] = [];
  const walk = (value: unknown, key = '', depth = 0): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      values.push(value);
      if (
        /^(upstream|downstream|target|peer[._]service|server[._]address|destination[._]address|url|url[._]full|connection[._]url)$/i.test(
          key
        )
      ) {
        const resolved = endpoint(value);
        if (resolved) add(resolved.entity, 'explicit_endpoint', resolved.protocol);
      }
      if (
        /^(failed[._]hop|failed[._]target|supplier)$/i.test(key) &&
        /failed|unavailable|timeout|connect|call/i.test(text)
      ) {
        const target = resolve(value);
        if (target) add(target, 'failed_target');
      }
    } else if (typeof value === 'number' && value > 0 && Number.isFinite(value)) {
      const counter = key.match(/^(.+)\.(attempts|calls|requests)$/i);
      const target = counter ? resolve(counter[1]) : undefined;
      if (target) add(target, 'named_call_counter');
    } else if (Array.isArray(value)) {
      if (/^(suppliers[._]failed|dependencies[._]failed)$/i.test(key)) {
        for (const name of value.slice(0, 20)) {
          const target = typeof name === 'string' ? resolve(name) : undefined;
          if (target) add(target, 'failed_target');
        }
      }
      for (const item of value.slice(0, 30)) walk(item, key, depth + 1);
    } else if (value && typeof value === 'object') {
      if (/^(hops|dependency_timings|upstream_timings)$/i.test(key)) {
        for (const [name, timing] of Object.entries(value).slice(0, 30)) {
          const target = resolve(name);
          if (target && typeof timing === 'number' && timing >= 0 && Number.isFinite(timing))
            add(target, 'named_hop_timing');
        }
      }
      for (const [name, child] of Object.entries(value).slice(0, 100)) walk(child, name, depth + 1);
    }
  };
  try {
    walk(JSON.parse(text));
  } catch {
    values.push(text);
  }
  for (const value of values) {
    if (
      !/\b(get|post|put|patch|delete|head|connect|request|upstream|call|timeout|connection|failed|error|dial|database)\b/i.test(
        value
      )
    )
      continue;
    for (const url of value.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"<>]+/gi) ?? []) {
      const resolved = endpoint(url);
      if (resolved) add(resolved.entity, 'explicit_endpoint', resolved.protocol);
    }
    for (const match of value.matchAll(/\b(?:host|server|upstream)[= ]+([\w.-]+)(?::\d+)?/gi)) {
      const target = resolve(match[1]);
      if (target) add(target, 'explicit_endpoint');
    }
  }
  return candidates;
};
