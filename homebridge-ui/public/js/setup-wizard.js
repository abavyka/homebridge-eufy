(function (root) {
  'use strict';

  /** The browser key marking a sign-in whose devices have not been walked through yet. */
  const PENDING_KEY = 'homebridge-eufy.setup-wizard-pending';

  /**
   * The devices the wizard walks through, in the map's order so the arrows follow it: each HomeBase then what hangs
   * off it, then the devices that stand alone. Every camera is one, and every other device with a HomeKit choice to
   * make; a device the plugin only diagnoses has nothing to set.
   */
  function steps(devices) {
    const walkable = (devices ?? []).filter(
      (device) => !device.diagnosticOnly && (device.deviceClass === 'camera' || device.preferences?.length > 0),
    );
    const { bases, standalone } = topology(walkable, devices);
    return [
      ...bases.flatMap(({ base, members }) => [...(base && walkable.includes(base) ? [base] : []), ...members]),
      ...standalone,
    ];
  }

  /** The progress line for one step, from a template naming `{current}` and `{total}`. */
  function progress(template, index, total) {
    return (template ?? '').replace('{current}', String(index + 1)).replace('{total}', String(total));
  }

  /**
   * The household as the map draws it: each HomeBase with the devices that hang off it, then the devices that are
   * their own station. A base is named by its own entry where the dashboard lists one; a device whose base it does
   * not list stays with that base all the same, under no name.
   */
  function topology(steps, devices) {
    const bases = new Map();
    const standalone = [];
    for (const device of devices ?? []) {
      if (device.deviceClass === 'homebase') bases.set(device.serial, { base: device, members: [] });
    }
    for (const device of steps) {
      if (device.deviceClass === 'homebase') continue;
      if (!device.station) {
        standalone.push(device);
        continue;
      }
      if (!bases.has(device.station)) bases.set(device.station, { base: undefined, members: [] });
      bases.get(device.station).members.push(device);
    }
    return { bases: [...bases.values()], standalone };
  }

  root.HomebridgeEufySetupWizard = { PENDING_KEY, steps, progress, topology };
})(window);
