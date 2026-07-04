import { useEffect } from 'react';
import { IconExternal, IconX } from './Icons';

export interface LightboxMedia {
  url: string;
  kind: 'image' | 'video';
  caption?: string;
}

/**
 * Full-screen preview overlay for an image or video — keeps previews in-app.
 * Closes on backdrop click or Escape.
 */
export function Lightbox({ media, onClose }: { media: LightboxMedia; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="lightbox-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="lightbox-body" onClick={(e) => e.stopPropagation()}>
        <button className="lightbox-close" onClick={onClose} aria-label="Close preview">
          <IconX />
        </button>
        {media.kind === 'video' ? (
          <video className="lightbox-media" src={media.url} controls autoPlay loop playsInline />
        ) : (
          <img className="lightbox-media" src={media.url} alt={media.caption ?? 'preview'} />
        )}
        {media.caption && <div className="lightbox-caption">{media.caption}</div>}
        <a className="lightbox-open" href={media.url} target="_blank" rel="noreferrer">
          Open original <IconExternal />
        </a>
      </div>
    </div>
  );
}
