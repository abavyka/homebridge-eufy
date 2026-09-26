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
   * Which screen a session puts on the panel. A session that is not capturing is still a question to answer,
   * since picking an area replaces it with a capture of that area.
   */
  function screen(session) {
    if (session.partialExportAvailable) return 'review';
    if (session.status === 'reproducing') return 'reproduce';
    if (session.status === 'complete') return 'status';
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
