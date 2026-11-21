const channels = {
  retail: { label: 'Retail', branch: 'live', family: 'Mainline', game: 'Standard', manifest: '../data/manifest.json' },
  forever: { label: 'Forever beta', branch: 'forever', family: 'Mainline', game: 'Camelot', manifest: '../data/forever/manifest.json' },
};

export const CHANNELS = Object.keys(channels);

export function channelProfile(channel = 'retail') {
  const profile = channels[channel];
  if (!Object.hasOwn(channels, channel)) throw new Error(`Unsupported channel "${channel}". Use retail or forever.`);
  return profile;
}

export function channelManifest(channel = 'retail') {
  return new URL(channelProfile(channel).manifest, import.meta.url);
}

export function matchesChannel(version, channel) {
  channelProfile(channel);
  const versionParts = typeof version === 'string' && /^(\d+)\.(\d+)\.\d+(?:\.\d+)?$/.exec(version);
  if (!versionParts) return false;
  const [, major, minor] = versionParts;
  return channel === 'forever' ? major === '1' && minor === '60' : Number(major) >= 10;
}
