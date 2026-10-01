/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import {
  AppStatus,
  DEFAULT_APP_CATEGORIES,
  type AppUpdater,
  type CoreSetup,
  type CoreStart,
  type Plugin,
  type PluginInitializerContext,
} from '@kbn/core/public';
import type { Logger } from '@kbn/logging';
import { i18n } from '@kbn/i18n';
import { Subject, type Subscription } from 'rxjs';
import { getSpaceIdFromPath } from '@kbn/core-spaces-common';
import {
  ALERTZERO_APP_ID,
  ALERTZERO_APP_PATH,
  ALERTZERO_ENABLED_SETTING_ID,
} from '@kbn/alertzero-common';
import { getAlertZeroDeepLinks } from './deep_links';
import { registerAlertZeroAttachmentTypesUI } from './agent_builder/attachment_types';
import type {
  AlertZeroClientConfig,
  AlertZeroPublicSetup,
  AlertZeroPublicStart,
  AlertZeroSetupDependencies,
  AlertZeroStartDependencies,
} from './types';

// Kept as a literal rather than `ALERTZERO_PLUGIN_NAME`: the i18n extractor only reads
// string literals, so a constant reference here would silently drop the message.
const APP_TITLE = i18n.translate('xpack.alertzero.appTitle', {
  defaultMessage: 'AlertZero',
});

export class AlertZeroPublicPlugin
  implements
    Plugin<
      AlertZeroPublicSetup,
      AlertZeroPublicStart,
      AlertZeroSetupDependencies,
      AlertZeroStartDependencies
    >
{
  private readonly config: AlertZeroClientConfig;
  private statusSubscription?: Subscription;
  private readonly logger: Logger;
  /**
   * Allows `start()` to push updated deep links (with capability-resolved visibility)
   * after capabilities become available, without re-registering the application.
   */
  private readonly appUpdater$ = new Subject<AppUpdater>();

  constructor(context: PluginInitializerContext<AlertZeroClientConfig>) {
    this.config = context.config.get();
    this.logger = context.logger.get();
  }

  public setup(
    coreSetup: CoreSetup<AlertZeroStartDependencies, AlertZeroPublicStart>,
    _setupDeps: AlertZeroSetupDependencies
  ): AlertZeroPublicSetup {
    if (!this.config.enabled) {
      return { enabled: false };
    }

    coreSetup.application.register({
      id: ALERTZERO_APP_ID,
      title: APP_TITLE,
      appRoute: ALERTZERO_APP_PATH,
      category: DEFAULT_APP_CATEGORIES.security,
      euiIconType: 'securitySignalDetected',
      // Inaccessible until the per-space setting is on. Core then empties `visibleIn` and
      // `deepLinks` for us, which is what removes the AlertZero nodes from the Security
      // navigation tree — those trees hold no check of their own.
      status: AppStatus.inaccessible,
      visibleIn: ['classicSideNav', 'projectSideNav', 'globalSearch'],
      order: 101,
      // Initial deep links without capability filtering — capabilities are not available at
      // setup. `start()` emits an update via appUpdater$ once capabilities are known.
      deepLinks: getAlertZeroDeepLinks(),
      updater$: this.appUpdater$,
      mount: async (params) => {
        const [coreStart, startDeps] = await coreSetup.getStartServices();
        const { renderApp } = await import('./application');
        return renderApp({
          coreStart,
          startDeps,
          params,
        });
      },
    });

    return { enabled: true };
  }

  public start(core: CoreStart, startDeps: AlertZeroStartDependencies): AlertZeroPublicStart {
    if (!this.config.enabled) {
      return {};
    }

    // Push capability-resolved deep links now that `core.application.capabilities` is available.
    this.appUpdater$.next(() => ({
      deepLinks: getAlertZeroDeepLinks(core.application.capabilities),
    }));

    // Reactively gate the app status on the per-space setting so toggling it makes the app
    // accessible/inaccessible without a reload.
    this.statusSubscription = core.uiSettings
      .get$<boolean>(ALERTZERO_ENABLED_SETTING_ID, false)
      .subscribe((settingEnabled) => {
        this.appUpdater$.next(() => ({
          status: settingEnabled ? AppStatus.accessible : AppStatus.inaccessible,
          deepLinks: getAlertZeroDeepLinks(core.application.capabilities),
        }));
      });

    // Space id comes from the base path so registration starts synchronously.
    const { spaceId } = getSpaceIdFromPath(
      core.http.basePath.get(),
      core.http.basePath.serverBasePath
    );

    registerAlertZeroAttachmentTypesUI(startDeps.agentBuilder.attachments, {
      http: core.http,
      navigation: {
        share: startDeps.share,
        spaceId,
        prependPath: (path) => core.http.basePath.prepend(path),
        getUrlForApp: core.application.getUrlForApp,
      },
    }).catch((error) => {
      this.logger.error('Failed to register AlertZero attachment UI definitions', error);
    });

    return {};
  }

  public stop() {
    this.statusSubscription?.unsubscribe();
  }
}
