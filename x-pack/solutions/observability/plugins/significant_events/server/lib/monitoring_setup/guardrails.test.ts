/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  observedMonitoredServices,
  serviceOwnershipTags,
  servicesFromOwnershipTags,
  assertServiceRuleCapacity,
  serviceRuleUsage,
} from './guardrails';

describe('observed monitor ownership', () => {
  it('uses actual scoped probe dimensions even before the service entity KI exists', () => {
    const services = observedMonitoredServices(
      [
        { name: 'resource.attributes.service.name' },
        { name: 'service.name' },
        { name: 'resource.attributes.service.namespace' },
        { name: 'service.namespace' },
      ],
      [
        [null, 'checkout_java', null, 'shop'],
        ['checkout_java', null, 'shop', null],
      ]
    );
    expect(services).toEqual(['["checkout-java","shop"]']);
    expect(servicesFromOwnershipTags(serviceOwnershipTags(services))).toEqual(services);
    expect(() => assertServiceRuleCapacity(services, new Map(), 'candidate')).not.toThrow();
  });

  it('keeps the seven-rule cap for observed emitters across source references', () => {
    const services = observedMonitoredServices(
      [{ name: 'service.name' }, { name: 'service.namespace' }],
      [['checkout-java', 'shop']]
    );
    const rules = Array.from({ length: 7 }, (_, index) => ({
      id: `rule-${index}`,
      enabled: true,
      metadata: { tags: serviceOwnershipTags(services) },
    }));
    const usage = serviceRuleUsage(rules, [], []);
    expect(() => assertServiceRuleCapacity(services, usage, 'new-rule')).toThrow('at most 7');
    expect(() => assertServiceRuleCapacity(services, usage, 'rule-0')).not.toThrow();
  });

  it('does not treat a target attribute as the emitting service', () => {
    expect(observedMonitoredServices([{ name: 'attributes.service.name' }], [['target']])).toEqual(
      []
    );
    expect(() => assertServiceRuleCapacity([], new Map(), 'candidate')).toThrow('emitting');
  });
  it('does not erase namespace boundaries when a grouped query omits the namespace column', () => {
    expect(observedMonitoredServices([{ name: 'service.name' }], [['checkout-java']])).toEqual([]);
  });
});
