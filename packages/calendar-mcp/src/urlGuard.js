// Requests to iCloud carry the user's credentials, so the server must never be
// talked into sending a request to any URL outside the user's own calendars.

export function isICloudHttps(url) {
  return url.protocol === "https:" && (url.hostname === "icloud.com" || url.hostname.endsWith(".icloud.com"));
}

/**
 * Returns the normalized URL if it is an event (.ics) inside one of the given calendars; throws otherwise.
 * @param {string} url
 * @param {string[]} calendarUrls  normalized calendar collection URLs
 */
export function assertOwnedEventUrl(url, calendarUrls) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw new Error("Invalid event URL.");
  }
  if (!isICloudHttps(target) || !target.pathname.endsWith(".ics")) {
    throw new Error("Refused: the URL is not an iCloud event URL.");
  }
  const owned = calendarUrls.some((c) => {
    const cal = new URL(c);
    return cal.origin === target.origin && target.pathname.startsWith(cal.pathname.replace(/\/?$/, "/"));
  });
  if (!owned) throw new Error("Refused: the URL does not belong to one of your calendars.");
  return target.href;
}
