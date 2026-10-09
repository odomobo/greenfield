import { HostClock } from '../state'

/**
 * The taskbar shows the session host's time, not the browser's: the host sends its clock and time zone (`shell.clock`),
 * the viewer keeps the difference to its own clock and formats times in the host's zone. Until it arrives, the browser's.
 */

/** The host's current time. */
export function hostNow(clock: HostClock | undefined): Date {
  return new Date(Date.now() + (clock?.offset ?? 0))
}

function zone(clock: HostClock | undefined): { timeZone?: string } {
  if (clock === undefined) {
    return {}
  }
  try {
    new Intl.DateTimeFormat([], { timeZone: clock.timeZone })
    return { timeZone: clock.timeZone }
  } catch {
    // a zone this browser doesn't know
    return {}
  }
}

/** A time of day (hours and minutes) in the host's zone. */
export function formatTime(time: Date | number, clock: HostClock | undefined): string {
  return new Date(time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', ...zone(clock) })
}

/** A full date in the host's zone. */
export function formatDate(time: Date | number, clock: HostClock | undefined): string {
  return new Date(time).toLocaleDateString([], {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    ...zone(clock),
  })
}
