// The brand as the pages draw it. Every slot resolves through brand-files.ts:
// an instance's own art from data/brand/ when present, else the Rimeward
// crystal — as an inline component for the wordmark and emblem (crisp, no
// request), as /brand/<slot> everywhere a URL is needed.
import RimewardMark from '../../assets/rimeward-mark.svg';
import RimewardLockup from '../../assets/rimeward-lockup.svg';
import { brandOverride, type Slot } from './brand-files.ts';

export { RimewardMark, RimewardLockup };
export type { Slot };

/** The URL for an overridden slot; null means draw the built-in component. */
export const brandSrc = (slot: Slot): string | null => (brandOverride(slot) ? `/brand/${slot}` : null);
