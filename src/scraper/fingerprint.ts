/**
 * Browser identity helpers: turn one UA string into every view the page exposes of it.
 *
 * Why this exists: Google's bot scoring cross-checks `navigator.userAgent` against
 * `navigator.platform` and the `Sec-CH-UA*` client-hints headers. When those disagree
 * (our hardcoded Windows UA running on a Linux box, or client hints reporting the real
 * Chrome build while the UA claims another) it is an immediate consistency tell.
 * Everything here derives from the UA string alone so the three views can never drift.
 */

/** The client-hints fields we set (structurally compatible with CDP's UserAgentMetadata). */
export interface UaMetadata {
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  platform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  mobile: boolean;
  wow64: boolean;
}

/** What a page must report for a UA string to be self-consistent. */
export interface UaProfile {
  /** Value for Emulation.setUserAgentOverride.platform — what navigator.platform must report. */
  navigatorPlatform: string;
  /** Client-hints metadata so Sec-CH-UA agrees with the UA string. */
  metadata: UaMetadata;
}

/**
 * Parse a desktop Chrome UA into the platform + client hints that agree with it,
 * or null when the UA is missing a Chrome version or uses an OS we do not map —
 * callers then leave platform/metadata untouched instead of guessing wrong.
 */
export function parseUaProfile(ua: string): UaProfile | null {
  const version = /Chrome\/(\d[\d.]*)/.exec(ua)?.[1]?.replace(/\.+$/, "");
  if (!version) return null;
  const major = version.split(".")[0]!;

  let navigatorPlatform: string;
  let platform: string;
  let platformVersion: string;
  let architecture = "x86";
  let bitness = "64";

  if (/Windows NT \d+\.\d+/.test(ua)) {
    navigatorPlatform = "Win32";
    platform = "Windows";
    // "Windows NT 10.0" → "10.0.0": UA-CH wants the OS version padded, not the NT token.
    platformVersion = `${/Windows NT (\d+\.\d+)/.exec(ua)![1]}.0`;
    // A 64-bit claim carries "; Win64; x64"; anything else in the NT family is 32-bit.
    bitness = /; Win64; x64/.test(ua) ? "64" : "32";
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    navigatorPlatform = "MacIntel";
    platform = "macOS";
    // The UA froze at 10_15_7 years ago, so the real OS version is not derivable from it;
    // a stable placeholder keeps navigator.userAgentData and the headers mutually equal.
    platformVersion = "13.0.0";
  } else if (/X11|Linux/.test(ua)) {
    navigatorPlatform = "Linux x86_64";
    platform = "Linux";
    platformVersion = "0.0.0";
  } else {
    // Mobile or unknown OS: no profile we could vouch for.
    return null;
  }

  return {
    navigatorPlatform,
    metadata: {
      // The grease brand deliberately carries an independent version, as real Chrome's does.
      brands: [
        { brand: "Google Chrome", version: major },
        { brand: "Chromium", version: major },
        { brand: "Not_A Brand", version: "99" },
      ],
      fullVersionList: [
        { brand: "Google Chrome", version },
        { brand: "Chromium", version },
        { brand: "Not_A Brand", version: "99" },
      ],
      platform,
      platformVersion,
      architecture,
      bitness,
      mobile: false,
      wow64: false,
    },
  };
}
