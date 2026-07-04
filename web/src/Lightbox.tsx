import { useEffect } from 'react';

export interface LightboxMedia {
  url: string;
  kind: 'image' | 'video';
  caption?: string;
}

/**
 * Full-screen preview overlay for an image or video — replaces "open in a new
 * tab" so previews stay in-app. Closes on backdrop click or Escape.
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
          ✕
        </button>
        {media.kind === 'video' ? (
          <video className="lightbox-media" src={media.url} controls autoPlay loop playsInline />
        ) : (
          <img className="lightbox-media" src={media.url} alt={media.caption ?? 'preview'} />
        )}
        {media.caption && <div className="lightbox-caption">{media.caption}</div>}
        <a className="lightbox-open" href={media.url} target="_blank" rel="noreferrer">
          Open original ↗
        </a>
      </div>
    </div>
  );
}
