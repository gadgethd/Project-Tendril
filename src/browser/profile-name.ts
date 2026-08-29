import { TendrilError } from '../errors.js';

const PORTABLE_PROFILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function validateProfileName(profile: string): string {
  if (
    !PORTABLE_PROFILE_NAME.test(profile)
    || /[. ]$/.test(profile)
    || WINDOWS_DEVICE_BASENAME.test(profile)
  ) {
    throw new TendrilError(
      'CONFIGURATION_ERROR',
      'Profile names must be 1-64 portable filename characters, must not end in a dot or space, and must not use a reserved device name',
    );
  }
  return profile;
}
