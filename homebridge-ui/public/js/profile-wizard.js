(function attachDiagnosticsWizard(global) {
  const profiles = [
    'startup-authentication',
    'device-representation',
    'control-state',
    'live-media',
    'hksv-recording',
    'dashboard-ui',
    'other',
  ];

  /**
   * Which screen a session puts on the panel: its file while one can be downloaded, its capture while one runs, and
   * otherwise the question, since picking an area replaces the session with a capture of that area.
   */
  function screen(session) {
    if (session.partialExportAvailable) return 'review';
    if (session.status === 'reproducing') return 'reproduce';
    return 'choose';
  }

  function backgroundActive(session) {
    return session.status === 'reproducing' && session.profile === 'dashboard-ui';
  }

  global.HomebridgeEufyDiagnosticsWizard = {
    backgroundActive,
    profiles,
    screen,
  };
})(window);
