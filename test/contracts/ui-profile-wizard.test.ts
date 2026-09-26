import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

interface DiagnosticsWizard {
  backgroundActive(session: { profile?: string; status: string }): boolean;
  profiles: readonly string[];
  screen(session: { partialExportAvailable?: boolean; status: string }): string;
}

function loadWizard(): DiagnosticsWizard {
  const script = readFileSync(new URL('../../homebridge-ui/public/js/profile-wizard.js', import.meta.url), 'utf8');
  const window = {} as { HomebridgeEufyDiagnosticsWizard?: DiagnosticsWizard };
  runInNewContext(script, { window });
  return window.HomebridgeEufyDiagnosticsWizard!;
}

describe('diagnostics profile wizard', () => {
  /** The opening screen offers every area at once, in the order they are shown, and a pick is the only question. */
  it('offers every area at once', () => {
    expect(loadWizard().profiles).toEqual([
      'startup-authentication',
      'device-representation',
      'control-state',
      'live-media',
      'hksv-recording',
      'dashboard-ui',
      'other',
    ]);
  });

  /**
   * Every area the opening screen offers has a tile in the markup, in the module's order, with a label and its
   * one-line summary in both catalogues. A profile added to one and not the other would otherwise ship a tile with
   * no label, or a label nothing reaches.
   */
  it('has a tile with a label and a summary in both languages for every area', () => {
    const wizard = loadWizard();
    const markup = readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');
    const english = JSON.parse(
      readFileSync(new URL('../../homebridge-ui/public/i18n/en.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const french = JSON.parse(
      readFileSync(new URL('../../homebridge-ui/public/i18n/fr.json', import.meta.url), 'utf8'),
    ) as Record<string, string>;
    const tiles = [
      ...markup.matchAll(
        /data-diagnostics-tile="([^"]+)">\s*<span data-i18n="([^"]+)"><\/span>\s*<small data-i18n="([^"]+)"><\/small>/g,
      ),
    ];

    expect(Object.keys(french).sort()).toEqual(Object.keys(english).sort());
    expect(tiles.map(([, profile]) => profile)).toEqual([...wizard.profiles]);
    for (const [, profile, ...keys] of tiles) {
      for (const key of keys) {
        expect(english[key], `${profile} in English`).toBeTruthy();
        expect(french[key], `${profile} in French`).toBeTruthy();
      }
    }
    expect(english.diagnosticsTilesHeading).toBe('What is going wrong?');
    expect(english.diagnosticsProfileDevices).toBe('Missing or incorrect device');

    const normalFlowKeys = [
      'diagnosticsControlAction',
      'diagnosticsControlSummary',
      'diagnosticsDashboardAction',
      'diagnosticsDashboardSummary',
      'diagnosticsDevicesAction',
      'diagnosticsDevicesSummary',
      'diagnosticsEvidenceReady',
      'diagnosticsLiveAction',
      'diagnosticsLiveSummary',
      'diagnosticsMissingEvidence',
      'diagnosticsOtherAction',
      'diagnosticsOtherSummary',
      'diagnosticsPrivacy',
      'diagnosticsRecordingAction',
      'diagnosticsRecordingSummary',
      'diagnosticsStartupAction',
      'diagnosticsStartupSummary',
      'diagnosticsSummary',
    ];
    expect(normalFlowKeys.map((key) => english[key]).join('\n')).not.toMatch(
      /bounded|evidence|observation|adapter|capability-admission|FFmpeg|reproduction interval|72-hour/i,
    );
    expect(normalFlowKeys.map((key) => french[key]).join('\n')).not.toMatch(
      /preuves|observation|adaptation|admission|FFmpeg|intervalle de reproduction|autorisation de 72/i,
    );
  });

  /** Only a capture under way leaves the areas; a session opened and never started is a question still to answer. */
  it('offers the archive of a finished session until the plugin ends it', () => {
    const wizard = loadWizard();

    expect(wizard.screen({ status: 'complete', partialExportAvailable: true })).toBe('review');
    expect(wizard.screen({ status: 'expired', partialExportAvailable: false })).toBe('choose');
    expect(wizard.screen({ status: 'inactive', partialExportAvailable: false })).toBe('choose');
    expect(wizard.screen({ status: 'authorized' })).toBe('choose');
    expect(wizard.screen({ status: 'reproducing' })).toBe('reproduce');
  });

  it('shows the background action only for an active dashboard reproduction', () => {
    const wizard = loadWizard();

    expect(wizard.backgroundActive({ status: 'reproducing', profile: 'dashboard-ui' })).toBe(true);
    expect(wizard.backgroundActive({ status: 'authorized', profile: 'dashboard-ui' })).toBe(false);
    expect(wizard.backgroundActive({ status: 'complete', profile: 'dashboard-ui' })).toBe(false);
    expect(wizard.backgroundActive({ status: 'reproducing', profile: 'control-state' })).toBe(false);
  });

  /**
   * Every tile has an inline icon, and no icon exists for a tile that does not. The data URI is inline because
   * a host with no route to the internet renders the panel the same as one with it.
   */
  it('gives every tile an inline icon and nothing else one', () => {
    const wizard = loadWizard();
    const stylesheet = readFileSync(new URL('../../homebridge-ui/public/app.css', import.meta.url), 'utf8');
    const masked = [
      ...stylesheet.matchAll(/data-diagnostics-tile='([^']+)'\]::before \{\s*mask-image: url\('data:image\/svg\+xml,/g),
    ].map(([, profile]) => profile);

    expect(masked.sort()).toEqual([...wizard.profiles].sort());
    expect(stylesheet, 'three to a row').toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(stylesheet, 'and two where three would not read').toMatch(
      /@media \(max-width: 420px\) \{[\s\S]*?\.diagnostics-tiles \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
    );
    expect(stylesheet, 'an icon fetched at render time is an icon a local host may never see').not.toMatch(
      /mask-image: url\('https?:/,
    );
  });
});
