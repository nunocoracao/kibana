/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { getEbtProps } from '@kbn/ebt-click';
import React from 'react';
import { EuiButton, EuiHorizontalRule, EuiText } from '@elastic/eui';
import { NIGHTSHIFT_APP_ID } from '@kbn/deeplinks-observability';
import { i18n } from '@kbn/i18n';
import { getNightshiftCapabilities } from '@kbn/nightshift-shared';
import { useKibana } from '../../hooks/use_kibana';
import { MaintenanceSection } from './components/maintenance_section';
import { SettingsSection } from './components/settings_section';

export const ProblemAgentSettingsTab = () => {
  const { application } = useKibana().services;
  const { canManageAndConfigure } = getNightshiftCapabilities(application.capabilities.nightshift);
  return (
    <SettingsSection
      title={i18n.translate('xpack.nightshift.settings.problemAgent.title', {
        defaultMessage: 'Problem Agent',
      })}
      data-test-subj="nightshiftDetectionProcessSection"
    >
      <EuiText size="s">
        <p>
          {i18n.translate('xpack.nightshift.settings.problemAgent.description', {
            defaultMessage:
              'One agent checks current telemetry, maintains active problems, and verifies recovery. Choose its model, schedule runs, inspect traces, and reset its outputs in Agent Explorer.',
          })}
        </p>
      </EuiText>
      <EuiButton
        {...getEbtProps({ action: 'agentSettings1', element: 'problemAgent' })}
        href={application.getUrlForApp(NIGHTSHIFT_APP_ID, { path: '/detections/agent' })}
        data-test-subj="nightshiftOpenAgentExplorer"
      >
        {i18n.translate('xpack.nightshift.settings.problemAgent.open', {
          defaultMessage: 'Open Agent Explorer',
        })}
      </EuiButton>
      <EuiHorizontalRule />
      <MaintenanceSection canManage={canManageAndConfigure} />
    </SettingsSection>
  );
};
