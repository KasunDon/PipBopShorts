/**
 * Inline SVG icon set — replaces all emoji iconography. 16px, stroke-based,
 * inherits `currentColor`, hidden from screen readers (labels carry meaning).
 */
import type { ReactNode, SVGProps } from 'react';

function I({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      className="icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconPlus = () => <I><path d="M12 5v14M5 12h14" /></I>;
export const IconPlay = () => <I><path d="M7 4.5v15l12-7.5z" /></I>;
export const IconRefresh = () => <I><path d="M21 12a9 9 0 1 1-2.6-6.3" /><path d="M21 3v6h-6" /></I>;
export const IconCheck = () => <I><path d="M4.5 12.5l5 5 10-11" /></I>;
export const IconX = () => <I><path d="M6 6l12 12M18 6L6 18" /></I>;
export const IconEye = () => <I><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></I>;
export const IconUpload = () => <I><path d="M12 16V4M6 10l6-6 6 6" /><path d="M4 20h16" /></I>;
export const IconDownload = () => <I><path d="M12 4v12M6 10l6 6 6-6" /><path d="M4 20h16" /></I>;
export const IconTrash = () => <I><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" /></I>;
export const IconChevronLeft = () => <I><path d="M15 5l-7 7 7 7" /></I>;
export const IconDoc = () => <I><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></I>;
export const IconWand = () => <I><path d="M4 20L15 9" /><path d="M15 4v2M19 8h2M17.5 5.5l1.4-1.4M12.5 5.5l-1.4-1.4M19.5 10.5l1.4 1.4" /></I>;
export const IconAlert = () => <I><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.4" fill="currentColor" /></I>;
export const IconDollar = () => <I><path d="M12 2v20" /><path d="M17 6.5c-.8-1.5-2.6-2.3-5-2.3-2.8 0-4.6 1.4-4.6 3.5 0 4.7 10 2.3 10 7.2 0 2.2-2 3.7-5.2 3.7-2.6 0-4.6-1-5.4-2.7" /></I>;
export const IconActivity = () => <I><path d="M3 12h4l3-8 4 16 3-8h4" /></I>;
export const IconImage = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M4.5 18.5l5-5 3.5 3.5 3-3 3.5 3.5" /></I>;
export const IconClock = () => <I><circle cx="12" cy="12" r="9" /><path d="M12 7v5.2l3.4 2" /></I>;
export const IconExternal = () => <I><path d="M14 4h6v6" /><path d="M20 4L10.5 13.5" /><path d="M19 13v7H4V5h7" /></I>;
export const IconEdit = () => <I><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19z" /></I>;
export const IconFilm = () => <I><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4" /></I>;
export const IconZoom = () => <I><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.8-4.8M8.5 11h5M11 8.5v5" /></I>;
export const IconLayers = () => <I><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></I>;
export const IconSettings = () => <I><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" /></I>;
export const IconHome = () => <I><path d="M4 11l8-7 8 7" /><path d="M6 10v10h12V10" /></I>;
export const IconCopy = () => <I><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></I>;
export const IconSend = () => <I><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></I>;
export const IconStop = () => <I><rect x="6" y="6" width="12" height="12" rx="1.5" /></I>;
export const IconExpand = () => <I><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></I>;
export const IconList = () => <I><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="0.5" fill="currentColor" /><circle cx="4" cy="12" r="0.5" fill="currentColor" /><circle cx="4" cy="18" r="0.5" fill="currentColor" /></I>;
export const IconPaperclip = () => <I><path d="M21 11.5l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.85 1.85 0 0 1-2.6-2.6l7.8-7.8" /></I>;
